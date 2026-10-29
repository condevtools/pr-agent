interface FilePatch {
  oldPath: string | null;
  newPath: string | null;
  hunks: Hunk[];
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: Array<{ kind: " " | "+" | "-"; text: string }>;
}

/** Strict, deterministic unified-diff application shared by publication and the sandbox. */
export function applyUnifiedPatch(
  files: ReadonlyMap<string, string>,
  patch: string,
): Map<string, string> {
  if (Buffer.byteLength(patch, "utf8") > 2 * 1024 * 1024 || patch.includes("\0")) {
    throw new Error("patch exceeds safe limits");
  }
  const output = new Map(files);
  const touched = new Set<string>();
  for (const filePatch of parsePatch(patch)) {
    const identity = filePatch.newPath ?? filePatch.oldPath;
    if (!identity || touched.has(identity)) throw new Error("patch contains a duplicate file");
    touched.add(identity);
    if (filePatch.oldPath && filePatch.newPath && filePatch.oldPath !== filePatch.newPath) {
      throw new Error("renames are unsupported");
    }
    if (filePatch.oldPath === null) {
      if (output.has(identity)) throw new Error("new patch file already exists");
      output.set(identity, applyHunks("", filePatch.hunks));
    } else {
      const original = output.get(filePatch.oldPath);
      if (original === undefined) throw new Error("patch source file is missing");
      if (filePatch.newPath === null) {
        const deleted = applyHunks(original, filePatch.hunks);
        if (deleted !== "") throw new Error("deleted patch leaves file content");
        output.delete(filePatch.oldPath);
      } else {
        output.set(filePatch.newPath, applyHunks(original, filePatch.hunks));
      }
    }
  }
  return output;
}

function parsePatch(patch: string): FilePatch[] {
  if (patch === "") return [];
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const result: FilePatch[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index]!.startsWith("diff --git ")) index += 1;
    while (lines[index]?.startsWith("index ") || lines[index]?.startsWith("new file mode ")
      || lines[index]?.startsWith("deleted file mode ")) index += 1;
    if (!lines[index]?.startsWith("--- ") || !lines[index + 1]?.startsWith("+++ ")) {
      throw new Error("invalid unified patch header");
    }
    const oldPath = parseHeaderPath(lines[index]!.slice(4), "a/");
    const newPath = parseHeaderPath(lines[index + 1]!.slice(4), "b/");
    index += 2;
    const hunks: Hunk[] = [];
    while (index < lines.length && !lines[index]!.startsWith("diff --git ")
      && !lines[index]!.startsWith("--- ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[index]!);
      if (!match) throw new Error("invalid unified patch hunk");
      const hunk: Hunk = { oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1),
        newStart: Number(match[3]), newCount: Number(match[4] ?? 1), lines: [] };
      if (![hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount].every(Number.isSafeInteger)) {
        throw new Error("patch hunk range is unsafe");
      }
      index += 1;
      while (index < lines.length && !lines[index]!.startsWith("@@ ")
        && !lines[index]!.startsWith("diff --git ") && !lines[index]!.startsWith("--- ")) {
        const line = lines[index]!;
        if (line === "\\ No newline at end of file") { index += 1; continue; }
        const kind = line[0];
        if (kind !== " " && kind !== "+" && kind !== "-") throw new Error("invalid unified patch line");
        hunk.lines.push({ kind, text: line.slice(1) });
        index += 1;
      }
      const oldLines = hunk.lines.filter(({ kind }) => kind !== "+").length;
      const newLines = hunk.lines.filter(({ kind }) => kind !== "-").length;
      if (oldLines !== hunk.oldCount || newLines !== hunk.newCount) throw new Error("patch hunk count mismatch");
      hunks.push(hunk);
    }
    if (hunks.length === 0) throw new Error("patch file has no hunks");
    result.push({ oldPath, newPath, hunks });
  }
  return result;
}

function applyHunks(original: string, hunks: readonly Hunk[]): string {
  const trailingNewline = original.endsWith("\n");
  const source = original === "" ? [] : original.slice(0, trailingNewline ? -1 : undefined).split("\n");
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (start < cursor || start > source.length) throw new Error("overlapping or out-of-range patch hunk");
    output.push(...source.slice(cursor, start));
    const expectedNewStart = hunk.newCount === 0 ? output.length : output.length + 1;
    if (hunk.newStart !== expectedNewStart) throw new Error("patch new range does not match source position");
    let oldCursor = start;
    for (const line of hunk.lines) {
      if (line.kind === "+") { output.push(line.text); continue; }
      if (source[oldCursor] !== line.text) throw new Error("patch context does not match source");
      if (line.kind === " ") output.push(line.text);
      oldCursor += 1;
    }
    cursor = oldCursor;
  }
  output.push(...source.slice(cursor));
  if (output.length === 0) return "";
  // Unified patches generated by the workflow are line oriented; preserve the source newline convention.
  return `${output.join("\n")}${trailingNewline || original === "" ? "\n" : ""}`;
}

function parseHeaderPath(value: string, prefix: "a/" | "b/"): string | null {
  const raw = value.split("\t", 1)[0]!;
  if (raw === "/dev/null") return null;
  if (!raw.startsWith(prefix)) throw new Error("patch paths must use a/ and b/ prefixes");
  const path = raw.slice(2);
  if (!path || path.length > 512 || path.startsWith("/") || path.includes("\\") || path.includes("\0")
      || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("unsafe patch path");
  }
  return path;
}
