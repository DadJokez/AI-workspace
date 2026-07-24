import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = fileURLToPath(
  new URL(
    "../../../infra/scripts/setup-alb-access-logs.sh",
    import.meta.url,
  ),
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("setup-alb-access-logs.sh", () => {
  it("creates and locks down the default production bucket", () => {
    const result = runScript();

    expect(result.status).toBe(0);
    const commands = readFileSync(result.capturePath, "utf8");
    expect(commands).toContain(
      "s3api create-bucket --bucket ai-workspace-alb-logs-123456789012-us-east-1",
    );
    expect(commands).toContain("s3api put-public-access-block");
    expect(commands).toContain("RestrictPublicBuckets=true");
    expect(commands).toContain("s3api put-bucket-ownership-controls");
    expect(commands).toContain("BucketOwnerEnforced");
    expect(commands).toContain("s3api put-bucket-encryption");
    expect(commands).toContain("AES256");
    expect(commands).toContain("SSE-C");
    expect(commands).toContain("s3api put-bucket-policy");
    expect(commands).toContain(
      "logdelivery.elasticloadbalancing.amazonaws.com",
    );
    expect(commands).toContain("alb/AWSLogs/123456789012/*");
    expect(commands).toContain("aws:SourceAccount");
    expect(commands).toContain(
      "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/*",
    );
    expect(commands).toContain("s3api put-bucket-lifecycle-configuration");
    expect(commands).toContain("ExpireAlbLogsAfter30Days");
    expect(commands).toContain('"Days":30');
  });

  it("reconciles an existing bucket without trying to recreate it", () => {
    const result = runScript({ bucketExists: true });

    expect(result.status).toBe(0);
    const commands = readFileSync(result.capturePath, "utf8");
    expect(commands).not.toContain("s3api create-bucket");
    expect(commands).toContain("s3api put-bucket-policy");
    expect(commands).toContain("s3api put-bucket-lifecycle-configuration");
    expect(result.stdout).toContain("Using existing");
  });

  it("supplies the location constraint outside us-east-1", () => {
    const result = runScript({ region: "us-west-2" });

    expect(result.status).toBe(0);
    expect(readFileSync(result.capturePath, "utf8")).toContain(
      "--create-bucket-configuration LocationConstraint=us-west-2",
    );
  });
});

function runScript({
  bucketExists = false,
  region = "us-east-1",
}: {
  bucketExists?: boolean;
  region?: string;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alb-access-logs-script-"));
  tempDirs.push(dir);
  const capturePath = join(dir, "commands.txt");
  const awsPath = join(dir, "aws");

  writeFileSync(
    awsPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'aws' >> "$FAKE_CAPTURE_PATH"
printf ' %s' "$@" >> "$FAKE_CAPTURE_PATH"
printf '\\n' >> "$FAKE_CAPTURE_PATH"

if [[ "$1 $2" == "sts get-caller-identity" ]]; then
  echo "123456789012"
elif [[ "$1 $2" == "s3api head-bucket" ]]; then
  [[ "$FAKE_BUCKET_EXISTS" == "1" ]]
fi
`,
  );
  chmodSync(awsPath, 0o755);

  const result = spawnSync("bash", [SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      AWS_DEFAULT_REGION: region,
      FAKE_CAPTURE_PATH: capturePath,
      FAKE_BUCKET_EXISTS: bucketExists ? "1" : "0",
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    capturePath,
  };
}
