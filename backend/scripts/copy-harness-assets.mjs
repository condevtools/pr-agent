import { cp, mkdir, writeFile } from "node:fs/promises";
import { buildCodeManifest } from "../dist/harness/versions.js";

const destination = new URL("../dist/harness/postgres/migrations/", import.meta.url);
await mkdir(destination, { recursive: true });
await cp(new URL("../src/harness/postgres/migrations/", import.meta.url), destination, { recursive: true });
await writeFile(new URL("../dist/harness/runtime-manifest.json", import.meta.url),
  JSON.stringify(await buildCodeManifest(new URL("../src/", import.meta.url))));
