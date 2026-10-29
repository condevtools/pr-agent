import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const backendRoot = new URL("../", import.meta.url);
// TypeScript does not remove outputs for moved/deleted sources.
await rm(new URL("dist/", backendRoot), { recursive: true, force: true });
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL("node_modules/typescript/bin/tsc", backendRoot)),
  "-p", "tsconfig.json",
], { cwd: fileURLToPath(backendRoot), stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await import("./copy-agent-runtime-assets.mjs");
