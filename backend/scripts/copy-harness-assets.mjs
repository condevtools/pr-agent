import { cp, mkdir } from "node:fs/promises";

const destination = new URL("../dist/harness/postgres/migrations/", import.meta.url);
await mkdir(destination, { recursive: true });
await cp(new URL("../src/harness/postgres/migrations/", import.meta.url), destination, { recursive: true });
