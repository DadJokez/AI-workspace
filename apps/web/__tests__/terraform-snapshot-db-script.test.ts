import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

// infra/terraform/scripts/snapshot-db.sh replaces
// infra/scripts/snapshot-rds-before-migrate.sh for the Terraform pipeline.
const script = fileURLToPath(
  new URL("../../../infra/terraform/scripts/snapshot-db.sh", import.meta.url),
);
const RELEASE_ID = "a".repeat(40);
const SNAPSHOT_ID = `pre-migrate-${"a".repeat(12)}-4242-1`;
const DB = "cmp-personal-stage-db";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().replace("Z", "+00:00");

const SNAPSHOT = {
  DBSnapshotIdentifier: SNAPSHOT_ID,
  DBInstanceIdentifier: DB,
  Status: "available",
  Encrypted: true,
  SnapshotCreateTime: daysAgo(0),
};

const EXISTING = [
  SNAPSHOT,
  // older than the 7 days kept: deleted
  { ...SNAPSHOT, DBSnapshotIdentifier: "pre-migrate-bbbbbbbbbbbb-1-1", SnapshotCreateTime: daysAgo(9) },
  // AWS CLI form with fractional seconds
  {
    ...SNAPSHOT,
    DBSnapshotIdentifier: "pre-migrate-cccccccccccc-2-1",
    SnapshotCreateTime: daysAgo(30).replace(/\.\d+/, ".123000"),
  },
  // within the 7 days: kept
  { ...SNAPSHOT, DBSnapshotIdentifier: "pre-migrate-dddddddddddd-3-1", SnapshotCreateTime: daysAgo(2) },
  // not a pre-migrate snapshot: kept
  { ...SNAPSHOT, DBSnapshotIdentifier: "cmp-personal-stage-db-final", SnapshotCreateTime: daysAgo(90) },
  // another instance's (the AWS filter would not return it; the script checks anyway): kept
  {
    ...SNAPSHOT,
    DBSnapshotIdentifier: "pre-migrate-eeeeeeeeeeee-4-1",
    DBInstanceIdentifier: "cmp-personal-prod-db",
    SnapshotCreateTime: daysAgo(90),
  },
  // still being created: kept
  {
    ...SNAPSHOT,
    DBSnapshotIdentifier: "pre-migrate-ffffffffffff-5-1",
    Status: "creating",
    SnapshotCreateTime: daysAgo(90),
  },
];

function run(overrides: Record<string, string | undefined> = {}, args = ["personal-stage"]) {
  const dir = mkdtempSync(join(tmpdir(), "terraform-snapshot-db-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "aws"),
    `#!/usr/bin/env bash
echo "$*" >> "$CALLS"
case "$1 $2" in
  "ssm get-parameters") printf '%s' "$PARAMETERS_RESPONSE" ;;
  "rds create-db-snapshot") exit "$CREATE_EXIT" ;;
  "rds wait") exit "$WAIT_EXIT" ;;
  "rds describe-db-snapshots")
    if [[ "$*" == *"--db-snapshot-identifier"* ]]; then printf '%s' "$SNAPSHOT_RESPONSE"
    else [ "$LIST_EXIT" = 0 ] || exit "$LIST_EXIT"; printf '%s' "$LIST_RESPONSE"; fi ;;
  "rds delete-db-snapshot") exit "$DELETE_EXIT" ;;
  *) echo "unexpected aws command: $*" >&2; exit 99 ;;
esac
`,
  );
  chmodSync(join(dir, "aws"), 0o755);
  const result = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CALLS: join(dir, "calls"),
      AWS_REGION: "us-east-1",
      RELEASE_ID,
      RUN_ID: "4242-1",
      CREATE_EXIT: "0",
      WAIT_EXIT: "0",
      LIST_EXIT: "0",
      DELETE_EXIT: "0",
      PARAMETERS_RESPONSE: JSON.stringify({
        Parameters: [
          { Name: "/comparative/personal-stage/20-data/db/instance_id", Value: DB },
          { Name: "/comparative/personal-stage/35-deploy-tasks/snapshot_keep_days", Value: "7" },
        ],
        InvalidParameters: [],
      }),
      SNAPSHOT_RESPONSE: JSON.stringify({ DBSnapshots: [SNAPSHOT] }),
      LIST_RESPONSE: JSON.stringify({ DBSnapshots: EXISTING }),
      ...overrides,
    },
  });
  let calls = "";
  try {
    calls = readFileSync(join(dir, "calls"), "utf8");
  } catch {
    /* invalid input exits before AWS */
  }
  return { ...result, calls };
}

function receiptOf(stdout: string) {
  const line = stdout.split("\n").find((l) => l.startsWith("Snapshot receipt: "));
  expect(line, stdout).toBeDefined();
  return JSON.parse((line as string).slice("Snapshot receipt: ".length));
}

describe("infra/terraform/scripts/snapshot-db.sh", () => {
  it("snapshots the instance named in SSM, waits, verifies, prunes and prints a receipt", () => {
    const result = run();

    expect(result.status, result.stderr).toBe(0);
    const calls = result.calls.split("\n");
    expect(calls[0]).toContain("/comparative/personal-stage/20-data/db/instance_id");
    expect(calls[0]).toContain("/comparative/personal-stage/35-deploy-tasks/snapshot_keep_days");
    expect(calls[1]).toContain("rds create-db-snapshot");
    expect(calls[1]).toContain(`--db-instance-identifier ${DB}`);
    expect(calls[1]).toContain(`--db-snapshot-identifier ${SNAPSHOT_ID}`);
    expect(calls[2]).toContain(`rds wait db-snapshot-available --region us-east-1 --db-snapshot-identifier ${SNAPSHOT_ID}`);
    expect(result.calls).toContain(`--db-instance-identifier ${DB} --snapshot-type manual`);
    const deleted = calls.filter((c) => c.startsWith("rds delete-db-snapshot"));
    expect(deleted).toEqual([
      "rds delete-db-snapshot --region us-east-1 --db-snapshot-identifier pre-migrate-bbbbbbbbbbbb-1-1 --output json",
      "rds delete-db-snapshot --region us-east-1 --db-snapshot-identifier pre-migrate-cccccccccccc-2-1 --output json",
    ]);
    expect(receiptOf(result.stdout)).toEqual({
      snapshot_id: SNAPSHOT_ID,
      db_instance_id: DB,
      release_id: RELEASE_ID,
      encrypted: true,
      pruned: ["pre-migrate-bbbbbbbbbbbb-1-1", "pre-migrate-cccccccccccc-2-1"],
    });
  });

  it("keeps the new snapshot when an old one cannot be deleted", () => {
    const result = run({ DELETE_EXIT: "254" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("could not delete pre-migrate-bbbbbbbbbbbb-1-1");
    expect(receiptOf(result.stdout).pruned).toEqual([]);
  });

  it("keeps the new snapshot when the earlier ones cannot be listed", () => {
    const result = run({ LIST_EXIT: "254" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("could not list the earlier snapshots");
    expect(result.calls).not.toContain("delete-db-snapshot");
  });

  it.each([
    { CREATE_EXIT: "1" },
    { WAIT_EXIT: "255" },
    { SNAPSHOT_RESPONSE: "not json" },
    { SNAPSHOT_RESPONSE: '{"DBSnapshots":[]}' },
    { SNAPSHOT_RESPONSE: JSON.stringify({ DBSnapshots: [{ ...SNAPSHOT, Status: "creating" }] }) },
    { SNAPSHOT_RESPONSE: JSON.stringify({ DBSnapshots: [{ ...SNAPSHOT, Encrypted: false }] }) },
    { SNAPSHOT_RESPONSE: JSON.stringify({ DBSnapshots: [{ ...SNAPSHOT, DBInstanceIdentifier: "other-db" }] }) },
    { SNAPSHOT_RESPONSE: JSON.stringify({ DBSnapshots: [{ ...SNAPSHOT, DBSnapshotIdentifier: "pre-migrate-other" }] }) },
  ])("fails closed without a receipt or any deletion: %j", (env) => {
    const result = run(env);

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Snapshot receipt");
    expect(result.calls).not.toContain("delete-db-snapshot");
  });

  it.each([
    [{ InvalidParameters: ["/comparative/personal-stage/20-data/db/instance_id"], Parameters: [] }, "SSM parameters not found"],
    [
      {
        InvalidParameters: [],
        Parameters: [
          { Name: "/comparative/personal-stage/20-data/db/instance_id", Value: DB },
          { Name: "/comparative/personal-stage/35-deploy-tasks/snapshot_keep_days", Value: "0" },
        ],
      },
      "is not a whole number of days",
    ],
    [
      {
        InvalidParameters: [],
        Parameters: [
          { Name: "/comparative/personal-stage/20-data/db/instance_id", Value: "db; rm -rf /" },
          { Name: "/comparative/personal-stage/35-deploy-tasks/snapshot_keep_days", Value: "7" },
        ],
      },
      "is not a database instance identifier",
    ],
  ])("refuses bad SSM values before snapshotting: %j", (response, message) => {
    const result = run({ PARAMETERS_RESPONSE: JSON.stringify(response) });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.calls).not.toContain("create-db-snapshot");
  });

  it.each([
    [{ RELEASE_ID: "main" }, ["personal-stage"]],
    [{ RUN_ID: "4242" }, ["personal-stage"]],
    [{}, ["Personal Stage"]],
    [{}, []],
  ])("rejects invalid input before calling AWS: %j %j", (env, args) => {
    const result = run(env, args);

    expect(result.status).toBe(2);
    expect(result.calls).toBe("");
  });
});
