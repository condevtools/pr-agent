import { readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EXCLUDED_DIRECTORIES = new Set(["fixtures", "support"]);

export async function discoverTests(root, predicate = isTestFile) {
  const absoluteRoot = resolve(root instanceof URL ? fileURLToPath(root) : root);
  const discovered = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path);
      } else if (entry.isFile() && predicate(entry.name)) {
        discovered.push(relative(absoluteRoot, path).split(sep).join("/"));
      }
    }
  }

  await visit(absoluteRoot);
  return discovered.sort();
}

export function isTestFile(name) {
  return name.endsWith(".test.ts");
}

export function isPostgresTestFile(name) {
  return name.endsWith(".pg.test.ts");
}

export function selectTests(available, requested) {
  if (!requested.length) return available;
  const selected = [];
  for (const request of requested) {
    const normalized = request.replaceAll("\\", "/").replace(/^tests\//, "");
    const matches = normalized.includes("/")
      ? available.filter((path) => path === normalized)
      : available.filter((path) => path.split("/").at(-1) === normalized);
    if (matches.length === 0) throw new Error(`Unknown test selection: ${request}`);
    if (matches.length > 1) throw new Error(`Ambiguous test selection: ${request} (${matches.join(", ")})`);
    if (!selected.includes(matches[0])) selected.push(matches[0]);
  }
  return selected.sort();
}

export function buildNodeTestArguments(forwardedArguments, tests) {
  const coverage = forwardedArguments.includes("--coverage");
  const nodeOptions = forwardedArguments.filter((argument) => argument !== "--coverage");
  const args = ["--import", "./scripts/test-environment.mjs", "--import", "tsx", "--test", "--test-force-exit"];
  if (coverage) args.push("--experimental-test-coverage");
  return [...args, ...nodeOptions, ...tests.map((path) => `tests/${path}`)];
}
