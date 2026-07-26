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
  new URL("../../../infra/scripts/setup-ops-alarms.sh", import.meta.url),
);
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("setup-ops-alarms.sh", () => {
  it("uses real AWS metrics and covers worker, target, and load-balancer failures", () => {
    const result = runScript();

    expect(result.status).toBe(0);
    const commands = readFileSync(result.capturePath, "utf8");
    expect(commands).not.toContain("RunningTaskCount");
    expect(commands).toContain("--namespace AWS/ECS");
    expect(commands).toContain("--metric-name LiveTaskCount");
    expect(commands).toContain("--threshold 1");
    expect(commands).toContain("--treat-missing-data breaching");
    for (const service of [
      "ai-workspace-chat-worker",
      "ai-workspace-memory-worker",
    ]) {
      expect(commands).toContain(`Name=ServiceName,Value=${service}`);
    }

    expect(commands).toContain("HTTPCode_Target_5XX_Count");
    expect(commands).toContain("HTTPCode_ELB_5XX_Count");
    expect(commands).toContain("Name=TargetGroup,Value=AiWork-WebTarget/abc123");
    expect(commands).toContain("chat-run-worker-error");
    expect(commands).not.toContain("run_failed");
  });

  it("leaves the CDK-owned alarms alone so no alarm has two writers", () => {
    const commands = readFileSync(runScript().capturePath, "utf8");

    // ai-workspace-web-unhealthy-hosts used to be written here AND by
    // AiWorkspaceEcsStack with different settings, so whichever ran last
    // silently won. CDK owns it now, along with the #568 task-floor alarm.
    expect(commands).not.toContain("ai-workspace-web-unhealthy-hosts");
    expect(commands).not.toContain("UnHealthyHostCount");
    expect(commands).not.toContain("ai-workspace-web-below-task-floor");
    expect(commands).not.toContain("ai-workspace-memory-capture-failures");
  });

  it("does not create a duplicate email subscription", () => {
    const result = runScript({ existingSubscription: true });

    expect(result.status).toBe(0);
    expect(readFileSync(result.capturePath, "utf8")).not.toContain(
      "sns subscribe",
    );
    expect(result.stdout).toContain("already subscribed");
  });

  it("fails closed when SNS rejects the alert endpoint", () => {
    const result = runScript({ subscribeFailure: true });

    expect(result.status).not.toBe(0);
    const commands = readFileSync(result.capturePath, "utf8");
    expect(commands).toContain("sns subscribe");
    expect(commands).not.toContain("cloudwatch put-metric-alarm");
  });

  it("fails closed when the production load balancer cannot be resolved", () => {
    const result = runScript({ missingLoadBalancer: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not resolve");
    expect(readFileSync(result.capturePath, "utf8")).not.toContain(
      "HTTPCode_Target_5XX_Count",
    );
  });

  it("documents commit tags as mutable rather than registry-enforced", () => {
    const deployment = readFileSync(
      join(ROOT, "docs/PRODUCTION_DEPLOYMENT.md"),
      "utf8",
    );

    expect(deployment).toContain("allow mutable tags");
    expect(deployment).not.toContain("immutable commit tag");
  });
});

function runScript({
  existingSubscription = false,
  subscribeFailure = false,
  missingLoadBalancer = false,
}: {
  existingSubscription?: boolean;
  subscribeFailure?: boolean;
  missingLoadBalancer?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ops-alarms-script-"));
  tempDirs.push(dir);
  const capturePath = join(dir, "commands.txt");
  const awsPath = join(dir, "aws");

  writeFileSync(
    awsPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'aws' >> "$FAKE_CAPTURE_PATH"
printf ' %s' "$@" >> "$FAKE_CAPTURE_PATH"
printf '\n' >> "$FAKE_CAPTURE_PATH"

if [[ "$1 $2" == "sns create-topic" ]]; then
  echo "arn:aws:sns:us-east-1:123456789012:ai-workspace-ops-alerts"
elif [[ "$1 $2" == "sns list-subscriptions-by-topic" ]]; then
  if [[ "$FAKE_EXISTING_SUBSCRIPTION" == "1" ]]; then
    echo "arn:aws:sns:us-east-1:123456789012:ai-workspace-ops-alerts:subscription"
  else
    echo "None"
  fi
elif [[ "$1 $2" == "sns subscribe" ]]; then
  if [[ "$FAKE_SUBSCRIBE_FAILURE" == "1" ]]; then
    echo "simulated invalid endpoint" >&2
    exit 1
  fi
  echo "PendingConfirmation"
elif [[ "$1 $2" == "elbv2 describe-load-balancers" ]]; then
  if [[ "$FAKE_MISSING_LOAD_BALANCER" == "1" ]]; then
    echo "None"
  else
    echo "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/ai-workspace/def456"
  fi
elif [[ "$1 $2" == "elbv2 describe-target-groups" ]]; then
  echo "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/AiWork-WebTarget/abc123"
fi
`,
  );
  chmodSync(awsPath, 0o755);

  const result = spawnSync("bash", [SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      AWS_DEFAULT_REGION: "us-east-1",
      OPS_ALERT_EMAIL: "ops@example.com",
      FAKE_CAPTURE_PATH: capturePath,
      FAKE_EXISTING_SUBSCRIPTION: existingSubscription ? "1" : "0",
      FAKE_SUBSCRIBE_FAILURE: subscribeFailure ? "1" : "0",
      FAKE_MISSING_LOAD_BALANCER: missingLoadBalancer ? "1" : "0",
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    capturePath,
  };
}
