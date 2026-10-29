import { createHash } from "node:crypto";

import type { FixSource, FixWorkflowPolicy, VerificationPolicy } from "./contracts.js";

export interface ValidatedPatch {
  patch: string;
  hash: string;
  files: readonly string[];
}

export interface ValidatedFixPatchPair {
  code: ValidatedPatch;
  test: ValidatedPatch;
}

const FORBIDDEN_PATH = /(^|\/)(?:\.git|\.github|\.gitlab|\.env(?:\.|$)|node_modules|vendor|dist|build|coverage|generated)(?:\/|$)|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|package\.json|tsconfig(?:\.[^/]*)?\.json|Dockerfile|Makefile)$/i;
const SENSITIVE_PATH = /(?:^|\/)(?:secrets?|credentials?|private[_-]?keys?|id_rsa|\.npmrc|\.pypirc)(?:[./_-]|$)/i;
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const GENERATED_EXTENSION = /\.(?:min\.js|map|lock|snap|pem|key|crt|p12|png|jpe?g|gif|pdf|zip|gz|wasm)$/i;

export class FixPatchValidationError extends Error {
  constructor(readonly code: string) { super(`fix patch rejected: ${code}`); this.name = "FixPatchValidationError"; }
}

export function validateFixPatchPair(
  codePatch: string,
  testPatch: string,
  source: FixSource,
  policy: FixWorkflowPolicy,
  sourceFiles: readonly { path: string; content: string }[],
): ValidatedFixPatchPair {
  const contents = new Map(sourceFiles.map((file) => [file.path, file.content]));
  return {
    code: validatePatch(codePatch, "code", source, policy.verification, policy, contents),
    test: validatePatch(testPatch, "test", source, policy.verification, policy, contents),
  };
}

function validatePatch(
  raw: string,
  kind: "code" | "test",
  source: FixSource,
  verification: VerificationPolicy,
  policy: FixWorkflowPolicy,
  sourceFiles: ReadonlyMap<string, string>,
): ValidatedPatch {
  const patch = raw.replaceAll("\r\n", "\n").trimEnd() + "\n";
  if (Buffer.byteLength(patch) > policy.maxPatchBytes) fail("patch_too_large");
  if (/GIT binary patch|Binary files .* differ|^old mode |^new mode |^new file mode 120000|^rename (?:from|to) /m.test(patch)) {
    fail("binary_mode_rename_or_symlink_forbidden");
  }
  const sections = splitFileSections(patch);
  if (sections.length === 0 || sections.length > policy.maxFilesPerPatch) fail("invalid_file_count");
  const files = sections.map((section) => validateSection(section, kind, source, verification, sourceFiles));
  if (new Set(files).size !== files.length) fail("duplicate_file");
  return { patch, hash: sha256(patch), files };
}

function splitFileSections(patch: string): string[] {
  const starts: number[] = [];
  const lines = patch.split("\n");
  lines.forEach((line, index) => { if (line.startsWith("diff --git ")) starts.push(index); });
  if (starts[0] !== 0) fail("invalid_unified_diff");
  return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length).join("\n"));
}

function validateSection(
  section: string,
  kind: "code" | "test",
  source: FixSource,
  policy: VerificationPolicy,
  sourceFiles: ReadonlyMap<string, string>,
): string {
  const lines = section.split("\n");
  const header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[0] ?? "");
  if (!header || header[1] !== header[2]) fail("path_change_forbidden");
  const path = header[2]!;
  validatePath(path);
  const oldHeader = lines.find((line) => line.startsWith("--- "));
  const newHeader = lines.find((line) => line.startsWith("+++ "));
  if (!oldHeader || newHeader !== `+++ b/${path}`) fail("invalid_patch_headers");
  const hunks = lines.filter((line) => line.startsWith("@@ "));
  if (hunks.length === 0) fail("missing_hunk");
  if (kind === "code") {
    if (oldHeader !== `--- a/${path}` || !source.allowedPaths.includes(path)) fail("code_path_out_of_context");
    if (TEST_PATH.test(path)) fail("test_change_in_code_patch");
    const content = sourceFiles.get(path);
    if (content === undefined) fail("source_file_missing");
    validateHunkContext(lines, content);
  } else {
    if (oldHeader !== "--- /dev/null" || !lines.includes("new file mode 100644")) fail("test_patch_must_add_file");
    if (!policy.allowedTestPrefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) {
      fail("test_path_not_allowed");
    }
    if (!TEST_PATH.test(path)) fail("test_file_not_recognized");
    for (const hunk of hunks) {
      const parsed = /^@@ -0,0 \+(\d+)(?:,(\d+))? @@/.exec(hunk);
      if (!parsed) fail("test_patch_modifies_existing_content");
    }
    if (lines.some((line) => line.startsWith("-") && !line.startsWith("---"))) fail("test_patch_deletes_content");
  }
  if (lines.some((line) => line.includes("\\ No newline at end of file"))) fail("non_text_patch_forbidden");
  return path;
}

function validateHunkContext(lines: readonly string[], content: string): void {
  const source = content.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(lines[index] ?? "");
    if (!header) continue;
    let sourceIndex = Number(header[1]) - 1; let consumed = 0;
    const expected = header[2] === undefined ? 1 : Number(header[2]);
    for (index += 1; index < lines.length && !lines[index]!.startsWith("@@ "); index += 1) {
      const line = lines[index]!;
      if (line === "") continue;
      if (line.startsWith("+") || line.startsWith("\\")) continue;
      if (!line.startsWith(" ") && !line.startsWith("-")) fail("invalid_hunk_line");
      if (source[sourceIndex] !== line.slice(1)) fail("patch_context_mismatch");
      sourceIndex += 1; consumed += 1;
    }
    if (consumed !== expected) fail("patch_hunk_count_mismatch");
    index -= 1;
  }
}

function validatePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\")
      || path.split("/").some((part) => part === "" || part === "." || part === "..")
      || FORBIDDEN_PATH.test(path) || SENSITIVE_PATH.test(path) || GENERATED_EXTENSION.test(path)) {
    fail("forbidden_path");
  }
}

function fail(code: string): never { throw new FixPatchValidationError(code); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
