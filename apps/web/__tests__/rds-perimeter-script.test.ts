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

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT_PATH = join(
  ROOT,
  "infra/scripts/reconcile-rds-perimeter.sh",
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("reconcile-rds-perimeter.sh", () => {
  it("waits through stale RDS reads before verifying the private perimeter", () => {
    const result = runScript("--apply", {
      publicState: true,
      stalePrivateReads: 2,
    });

    expect(result.status, result.stderr).toBe(0);
    const commands = readFileSync(result.capturePath, "utf8");
    expect(commands).toContain(
      "ec2 revoke-security-group-ingress --region us-east-1 --group-id sg-019e87b5938a295a4 --protocol tcp --port 5432 --cidr 0.0.0.0/0",
    );
    expect(commands).toContain(
      "rds modify-db-instance --region us-east-1 --db-instance-identifier ai-workspace-db --no-publicly-accessible --apply-immediately",
    );
    expect(commands).toContain("rds wait db-instance-available");
    expect(
      commands.match(/rds describe-db-instances/g)?.length,
    ).toBeGreaterThanOrEqual(5);
    expect(result.stdout).toContain("RDS perimeter reconciled");
  });

  it("fails closed when RDS never reflects the accepted private change", () => {
    const result = runScript("--apply", {
      publicState: true,
      stalePrivateReads: 10,
      privateWaitAttempts: 3,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Timed out waiting for ai-workspace-db to report PubliclyAccessible=false",
    );
    const commands = readFileSync(result.capturePath, "utf8");
    expect(commands).toContain("modify-db-instance");
    expect(commands).not.toContain("rds wait db-instance-available");
    expect(result.stdout).not.toContain("RDS perimeter reconciled");
  });

  it("is idempotent when the reviewed private perimeter is already live", () => {
    const result = runScript("--apply");

    expect(result.status, result.stderr).toBe(0);
    const commands = readFileSync(result.capturePath, "utf8");
    expect(commands).not.toContain("revoke-security-group-ingress");
    expect(commands).not.toContain("modify-db-instance");
    expect(commands).not.toContain("rds wait");
  });

  it("fails closed without mutating an unknown CIDR rule", () => {
    const result = runScript("--apply", { unknownCidr: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unexpected IPv4 source 203.0.113.0/24");
    const commands = readFileSync(result.capturePath, "utf8");
    expect(commands).not.toContain("revoke-security-group-ingress");
    expect(commands).not.toContain("modify-db-instance");
  });

  it("does not mistake a broader public rule for the exact removable rule", () => {
    const result = runScript("--apply", { broadPublicRule: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "unexpected all-protocol IPv4 source 0.0.0.0/0",
    );
    const commands = readFileSync(result.capturePath, "utf8");
    expect(commands).not.toContain("revoke-security-group-ingress");
    expect(commands).not.toContain("modify-db-instance");
  });

  it("fails a read-only check while either public control is still open", () => {
    const result = runScript("--check", { publicState: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("RDS is still publicly accessible");
    expect(result.stderr).toContain(
      "the 0.0.0.0/0 Postgres rule is still present",
    );
    const commands = readFileSync(result.capturePath, "utf8");
    expect(commands).not.toContain("revoke-security-group-ingress");
    expect(commands).not.toContain("modify-db-instance");
  });

  it("runs the apply gate before migration and the check after smoke", () => {
    const buildspec = readFileSync(join(ROOT, "buildspec.yml"), "utf8");
    const apply = buildspec.indexOf("reconcile-rds-perimeter.sh --apply");
    const migrate = buildspec.indexOf("run-ecs-deploy-task.sh migrate");
    const smoke = buildspec.indexOf("run-ecs-deploy-task.sh smoke");
    const check = buildspec.indexOf("reconcile-rds-perimeter.sh --check");

    expect(apply).toBeGreaterThan(-1);
    expect(apply).toBeLessThan(migrate);
    expect(check).toBeGreaterThan(smoke);
  });
});

function runScript(
  mode: "--apply" | "--check",
  {
    broadPublicRule = false,
    privateWaitAttempts = 5,
    publicState = false,
    stalePrivateReads = 0,
    unknownCidr = false,
  }: {
    broadPublicRule?: boolean;
    privateWaitAttempts?: number;
    publicState?: boolean;
    stalePrivateReads?: number;
    unknownCidr?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "rds-perimeter-script-"));
  tempDirs.push(dir);
  const capturePath = join(dir, "commands.txt");
  const awsPath = join(dir, "aws");

  writeFileSync(
    awsPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s' "$1" >> "$FAKE_CAPTURE_PATH"
printf ' %s' "${"$"}{@:2}" >> "$FAKE_CAPTURE_PATH"
printf '\\n' >> "$FAKE_CAPTURE_PATH"

case "$1 $2" in
  "cloudformation list-stack-resources")
    cat <<'JSON'
{"StackResourceSummaries":[{"LogicalResourceId":"WebSecurityGroup73AF7387","PhysicalResourceId":"sg-web","ResourceType":"AWS::EC2::SecurityGroup"},{"LogicalResourceId":"WorkerSecurityGroup5529CF0B","PhysicalResourceId":"sg-worker","ResourceType":"AWS::EC2::SecurityGroup"}]}
JSON
    ;;
  "cloudformation describe-stacks")
    cat <<'JSON'
{"Stacks":[{"Outputs":[{"OutputKey":"DeployTaskSecurityGroupId","OutputValue":"sg-deploy"}]}]}
JSON
    ;;
  "rds describe-db-instances")
    public=false
    if [[ "$FAKE_PUBLIC_STATE" == "1" && ! -f "$FAKE_STATE_DIR/private" ]]; then
      public=true
      if [[ -f "$FAKE_STATE_DIR/modify-requested" ]]; then
        stale_reads=0
        if [[ -f "$FAKE_STATE_DIR/stale-reads" ]]; then
          stale_reads=$(cat "$FAKE_STATE_DIR/stale-reads")
        fi
        if (( stale_reads >= FAKE_STALE_PRIVATE_READS )); then
          touch "$FAKE_STATE_DIR/private"
          public=false
        else
          printf '%s' "$((stale_reads + 1))" > "$FAKE_STATE_DIR/stale-reads"
        fi
      fi
    fi
    printf '{"DBInstances":[{"DBInstanceIdentifier":"ai-workspace-db","PubliclyAccessible":%s,"DBSubnetGroup":{"VpcId":"vpc-test"},"VpcSecurityGroups":[{"VpcSecurityGroupId":"sg-019e87b5938a295a4","Status":"active"}]}]}\\n' "$public"
    ;;
  "ec2 describe-security-groups")
    ip_ranges='[]'
    broad_ip_ranges='[]'
    if [[ "$FAKE_UNKNOWN_CIDR" == "1" ]]; then
      ip_ranges='[{"CidrIp":"203.0.113.0/24"}]'
    elif [[ "$FAKE_PUBLIC_STATE" == "1" && ! -f "$FAKE_STATE_DIR/revoked" ]]; then
      ip_ranges='[{"CidrIp":"0.0.0.0/0"}]'
    fi
    if [[ "$FAKE_BROAD_PUBLIC_RULE" == "1" ]]; then
      broad_ip_ranges='[{"CidrIp":"0.0.0.0/0"}]'
    fi
    printf '{"SecurityGroups":[{"GroupId":"sg-019e87b5938a295a4","VpcId":"vpc-test","IpPermissions":[{"IpProtocol":"tcp","FromPort":5432,"ToPort":5432,"UserIdGroupPairs":[{"GroupId":"sg-web"},{"GroupId":"sg-worker"},{"GroupId":"sg-deploy"}],"IpRanges":%s,"Ipv6Ranges":[],"PrefixListIds":[]},{"IpProtocol":"-1","UserIdGroupPairs":[{"GroupId":"sg-019e87b5938a295a4"}],"IpRanges":%s,"Ipv6Ranges":[],"PrefixListIds":[]}]},{"GroupId":"sg-web","VpcId":"vpc-test","IpPermissions":[]},{"GroupId":"sg-worker","VpcId":"vpc-test","IpPermissions":[]},{"GroupId":"sg-deploy","VpcId":"vpc-test","IpPermissions":[]}]}\\n' "$ip_ranges" "$broad_ip_ranges"
    ;;
  "ec2 revoke-security-group-ingress")
    touch "$FAKE_STATE_DIR/revoked"
    ;;
  "rds modify-db-instance")
    touch "$FAKE_STATE_DIR/modify-requested"
    echo '{}'
    ;;
  "rds wait")
    ;;
  *)
    echo "Unexpected fake AWS command: $*" >&2
    exit 91
    ;;
esac
`,
  );
  chmodSync(awsPath, 0o755);

  const result = spawnSync("bash", [SCRIPT_PATH, mode], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      AWS_DEFAULT_REGION: "us-east-1",
      FAKE_CAPTURE_PATH: capturePath,
      FAKE_BROAD_PUBLIC_RULE: broadPublicRule ? "1" : "0",
      FAKE_PUBLIC_STATE: publicState ? "1" : "0",
      FAKE_STALE_PRIVATE_READS: String(stalePrivateReads),
      FAKE_STATE_DIR: dir,
      FAKE_UNKNOWN_CIDR: unknownCidr ? "1" : "0",
      RDS_PRIVATE_WAIT_ATTEMPTS: String(privateWaitAttempts),
      RDS_PRIVATE_WAIT_INTERVAL_SECONDS: "0",
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    capturePath,
  };
}
