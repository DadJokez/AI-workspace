import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../infra/scripts/snapshot-rds-before-migrate.sh", import.meta.url));
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function run(overrides: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-test-"));
  dirs.push(dir);
  writeFileSync(join(dir, "aws"), `#!/usr/bin/env bash
echo "$*" >> "$CALLS"
if [[ "$2" == "create-db-snapshot" ]]; then exit "$CREATE_EXIT"; fi
if [[ "$2" == "wait" ]]; then exit "$WAIT_EXIT"; fi
printf '%s' "$SNAPSHOT_RESPONSE"
`);
  chmodSync(join(dir, "aws"), 0o755);
  const result = spawnSync("bash", [script], { encoding: "utf8", env: {
    ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: join(dir, "calls"),
    AWS_DEFAULT_REGION: "us-east-1", COMMIT_TAG: "a".repeat(40), CODEBUILD_BUILD_NUMBER: "98",
    CREATE_EXIT: "0", WAIT_EXIT: "0",
    SNAPSHOT_RESPONSE: JSON.stringify({ DBSnapshots: [{ Status: "available", Encrypted: true,
      DBSnapshotIdentifier: `pre-migrate-${"a".repeat(12)}-98`, DBInstanceIdentifier: "ai-workspace-db" }] }),
    ...overrides,
  } });
  let calls = "";
  try { calls = readFileSync(join(dir, "calls"), "utf8"); } catch { /* invalid input exits before AWS */ }
  return { ...result, calls };
}

it("creates an encrypted recovery point, waits, verifies and emits a scoped receipt", () => {
  const result = run();
  expect(result.status).toBe(0);
  expect(result.calls.split("\n")[0]).toContain("create-db-snapshot");
  expect(result.calls).toContain("wait db-snapshot-available");
  expect(result.stdout).toContain('"kind":"pre-migrate-snapshot"');
  expect(result.stdout).toContain('"commitSha":"' + "a".repeat(40));
});
it.each([{ CREATE_EXIT: "1" }, { WAIT_EXIT: "1" }, { SNAPSHOT_RESPONSE: "not json" },
  { SNAPSHOT_RESPONSE: '{"DBSnapshots":[]}' },
  { SNAPSHOT_RESPONSE: '{"DBSnapshots":[{"Status":"creating"}]}' },
])("fails closed without a recovery receipt: %j", (env) => {
  const result = run(env);
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain("Snapshot receipt");
});
it("rejects invalid source identifiers before calling AWS", () => {
  const result = run({ COMMIT_TAG: "main" });
  expect(result.status).not.toBe(0);
  expect(result.calls).toBe("");
});
it.each([
  { Encrypted: false }, { DBInstanceIdentifier: "other-db" },
  { DBSnapshotIdentifier: "pre-migrate-wrong-98" },
])("rejects an available but unsafe recovery point: %j", (override) => {
  const result = run({ SNAPSHOT_RESPONSE: JSON.stringify({ DBSnapshots: [{
    Status: "available", Encrypted: true, DBInstanceIdentifier: "ai-workspace-db",
    DBSnapshotIdentifier: `pre-migrate-${"a".repeat(12)}-98`, ...override,
  }] }) });
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain('"kind":"pre-migrate-snapshot"');
});
