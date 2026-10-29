import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { applyUnifiedPatch } from "/opt/pr-agent-verifier/unified-patch.js";

const MAX_INPUT_BYTES = 512 * 1024;
const chunks = [];
let inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += chunk.length;
  if (inputBytes > MAX_INPUT_BYTES) throw new Error("verifier input exceeds limit");
  chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (input.protocolVersion !== 1 || !Array.isArray(input.patches) || !Array.isArray(input.argv)
    || input.argv[0] !== "node" || input.argv[1] !== "--test") throw new Error("invalid verifier protocol");
const manifest = JSON.parse(await readFile("/snapshot/manifest.json", "utf8"));
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error("invalid snapshot manifest");

const root = "/workspace/run";
{
  await mkdir(root, { recursive: true });
  for (const file of manifest.files) {
    const path = safePath(file.path);
    const source = `/snapshot/files/${path}`;
    const info = await stat(source, { bigint: false });
    if (!info.isFile() || info.size !== file.size) throw new Error("snapshot file shape mismatch");
    const bytes = await readFile(source);
    if (sha256(bytes) !== file.sha256) throw new Error("snapshot file hash mismatch");
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { mode: 0o600 });
  }
}

const sourceFiles = new Map();
for (const file of manifest.files) sourceFiles.set(safePath(file.path), (await readFile(`/snapshot/files/${safePath(file.path)}`)).toString("utf8"));
const writePatched = async (root, patches) => {
  try {
    let files = sourceFiles;
    for (const patch of patches) files = applyUnifiedPatch(files, patch);
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    for (const [path, content] of files) {
      const destination = join(root, safePath(path));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, { mode: 0o600 });
    }
    return true;
  } catch { return false; }
};
const ready = await writePatched(root, input.patches);

const run = (root, argv, ready) => {
  if (!ready) return { status: "not_run", exitCode: null, failedTests: [], testsRun: 0,
    log: "patch_apply_failed", logTruncated: false };
  const result = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: "utf8",
    timeout: input.deadlineMs, maxBuffer: input.maxLogBytes * 2,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", NODE_ENV: "test", CI: "true" } });
  const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const log = redact(raw).slice(0, input.maxLogBytes);
  const timeout = result.error?.code === "ETIMEDOUT";
  const testsRun = Number([...raw.matchAll(/^# tests (\d+)$/gm)].at(-1)?.[1] ?? 0);
  return { status: timeout ? "timeout" : result.status === 0 ? "pass" : "fail",
    exitCode: typeof result.status === "number" ? result.status : null,
    failedTests: [...raw.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => sha256(match[1].trim())).slice(0, 10_000),
    testsRun, log, logTruncated: raw.length > log.length };
};
const output = run(root, input.argv, ready);
process.stdout.write(`VERIFIER_RESULT:${JSON.stringify(output)}\n`);

function safePath(value) {
  if (typeof value !== "string" || value.startsWith("/") || value.includes("\\") || value.includes("\0")
      || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("unsafe snapshot path");
  return value;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function redact(value) {
  return value.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]")
    .replace(/(["']?(?:token|password|passwd|secret|api[_-]?key)["']?\s*[:=]\s*["']?)([^\s,'"}]+)/gi, "$1[REDACTED]");
}
