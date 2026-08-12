import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(
  import.meta.resolve("bedrock-agentcore/browser/live-view"),
);
const source = join(
  dirname(entry),
  "nice-dcv-web-client-sdk",
  "dcvjs-esm",
);
const destination = join(
  process.cwd(),
  "public",
  "nice-dcv-web-client-sdk",
  "dcvjs-esm",
);

await rm(destination, { recursive: true, force: true });
await mkdir(dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true });
