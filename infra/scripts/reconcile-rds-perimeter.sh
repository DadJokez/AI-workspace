#!/usr/bin/env bash
# Enforce the interim production RDS network boundary until the database and
# private subnets are fully CDK-owned. The script removes only the historical
# 0.0.0.0/0 Postgres rule; any other unexpected ingress fails closed for
# operator review instead of being deleted silently.
set -euo pipefail

usage() {
  echo "Usage: $0 --apply|--check" >&2
}

mode="${1:-}"
if [[ "$mode" != "--apply" && "$mode" != "--check" ]]; then
  usage
  exit 2
fi

: "${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION is required}"

RDS_INSTANCE_ID="${RDS_INSTANCE_ID:-ai-workspace-db}"
RDS_SECURITY_GROUP_ID="${RDS_SECURITY_GROUP_ID:-sg-019e87b5938a295a4}"
ECS_STACK_NAME="${ECS_STACK_NAME:-AiWorkspaceEcsStack}"
ECS_DEPLOY_TASK_STACK_NAME="${ECS_DEPLOY_TASK_STACK_NAME:-AiWorkspaceDeployTasksStack}"
RDS_PRIVATE_WAIT_ATTEMPTS="${RDS_PRIVATE_WAIT_ATTEMPTS:-60}"
RDS_PRIVATE_WAIT_INTERVAL_SECONDS="${RDS_PRIVATE_WAIT_INTERVAL_SECONDS:-10}"

if ! [[ "$RDS_PRIVATE_WAIT_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "RDS_PRIVATE_WAIT_ATTEMPTS must be a positive integer" >&2
  exit 2
fi
if ! [[ "$RDS_PRIVATE_WAIT_INTERVAL_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "RDS_PRIVATE_WAIT_INTERVAL_SECONDS must be a non-negative integer" >&2
  exit 2
fi

resolve_stack_security_group() {
  local stack_name="$1"
  local logical_id_prefix="$2"
  local resources_json
  resources_json=$(aws cloudformation list-stack-resources \
    --region "$AWS_DEFAULT_REGION" \
    --stack-name "$stack_name" \
    --output json)

  STACK_RESOURCES_JSON="$resources_json" \
    LOGICAL_ID_PREFIX="$logical_id_prefix" \
    python3 <<'PY'
import json
import os

resources = json.loads(os.environ["STACK_RESOURCES_JSON"])
prefix = os.environ["LOGICAL_ID_PREFIX"]
matches = [
    item.get("PhysicalResourceId")
    for item in resources.get("StackResourceSummaries", [])
    if item.get("ResourceType") == "AWS::EC2::SecurityGroup"
    and str(item.get("LogicalResourceId", "")).startswith(prefix)
    and item.get("PhysicalResourceId")
]
if len(matches) != 1:
    raise SystemExit(
        f"Expected exactly one {prefix} security group in the stack; found {len(matches)}"
    )
print(matches[0])
PY
}

resolve_stack_output() {
  local stack_name="$1"
  local output_key="$2"
  local stack_json
  stack_json=$(aws cloudformation describe-stacks \
    --region "$AWS_DEFAULT_REGION" \
    --stack-name "$stack_name" \
    --output json)

  STACK_JSON="$stack_json" OUTPUT_KEY="$output_key" python3 <<'PY'
import json
import os

stacks = json.loads(os.environ["STACK_JSON"]).get("Stacks", [])
outputs = stacks[0].get("Outputs", []) if len(stacks) == 1 else []
matches = [item.get("OutputValue") for item in outputs if item.get("OutputKey") == os.environ["OUTPUT_KEY"]]
if len(matches) != 1 or not matches[0]:
    raise SystemExit(f"Expected stack output {os.environ['OUTPUT_KEY']}")
print(matches[0])
PY
}

rds_publicly_accessible() {
  local db_json
  db_json=$(aws rds describe-db-instances \
    --region "$AWS_DEFAULT_REGION" \
    --db-instance-identifier "$RDS_INSTANCE_ID" \
    --output json)

  DB_JSON="$db_json" RDS_INSTANCE_ID="$RDS_INSTANCE_ID" python3 <<'PY'
import json
import os

dbs = json.loads(os.environ["DB_JSON"]).get("DBInstances", [])
if len(dbs) != 1 or dbs[0].get("DBInstanceIdentifier") != os.environ["RDS_INSTANCE_ID"]:
    raise SystemExit("The expected RDS instance could not be resolved uniquely")
print("1" if dbs[0].get("PubliclyAccessible") else "0")
PY
}

wait_for_rds_private() {
  local attempt
  for ((attempt = 1; attempt <= RDS_PRIVATE_WAIT_ATTEMPTS; attempt++)); do
    if [[ "$(rds_publicly_accessible)" == "0" ]]; then
      aws rds wait db-instance-available \
        --region "$AWS_DEFAULT_REGION" \
        --db-instance-identifier "$RDS_INSTANCE_ID"
      return 0
    fi
    if ((attempt < RDS_PRIVATE_WAIT_ATTEMPTS)); then
      sleep "$RDS_PRIVATE_WAIT_INTERVAL_SECONDS"
    fi
  done

  echo "Timed out waiting for $RDS_INSTANCE_ID to report PubliclyAccessible=false" >&2
  return 1
}

WEB_SECURITY_GROUP_ID="${RDS_WEB_SECURITY_GROUP_ID:-$(resolve_stack_security_group "$ECS_STACK_NAME" "WebSecurityGroup")}"
WORKER_SECURITY_GROUP_ID="${RDS_WORKER_SECURITY_GROUP_ID:-$(resolve_stack_security_group "$ECS_STACK_NAME" "WorkerSecurityGroup")}"
DEPLOY_SECURITY_GROUP_ID="${RDS_DEPLOY_SECURITY_GROUP_ID:-$(resolve_stack_output "$ECS_DEPLOY_TASK_STACK_NAME" "DeployTaskSecurityGroupId")}"

inspect_perimeter() {
  local phase="$1"
  local db_json groups_json
  db_json=$(aws rds describe-db-instances \
    --region "$AWS_DEFAULT_REGION" \
    --db-instance-identifier "$RDS_INSTANCE_ID" \
    --output json)
  groups_json=$(aws ec2 describe-security-groups \
    --region "$AWS_DEFAULT_REGION" \
    --group-ids \
      "$RDS_SECURITY_GROUP_ID" \
      "$WEB_SECURITY_GROUP_ID" \
      "$WORKER_SECURITY_GROUP_ID" \
      "$DEPLOY_SECURITY_GROUP_ID" \
    --output json)

  DB_JSON="$db_json" \
    GROUPS_JSON="$groups_json" \
    RDS_INSTANCE_ID="$RDS_INSTANCE_ID" \
    RDS_SECURITY_GROUP_ID="$RDS_SECURITY_GROUP_ID" \
    EXPECTED_SOURCE_GROUP_IDS="$WEB_SECURITY_GROUP_ID $WORKER_SECURITY_GROUP_ID $DEPLOY_SECURITY_GROUP_ID" \
    INSPECTION_PHASE="$phase" \
    python3 <<'PY'
import json
import os

dbs = json.loads(os.environ["DB_JSON"]).get("DBInstances", [])
if len(dbs) != 1 or dbs[0].get("DBInstanceIdentifier") != os.environ["RDS_INSTANCE_ID"]:
    raise SystemExit("The expected RDS instance could not be resolved uniquely")

db = dbs[0]
db_group_id = os.environ["RDS_SECURITY_GROUP_ID"]
attached_groups = {
    item.get("VpcSecurityGroupId")
    for item in db.get("VpcSecurityGroups", [])
    if item.get("Status") == "active"
}
if attached_groups != {db_group_id}:
    raise SystemExit(
        "RDS must have exactly the reviewed security group attached; found "
        + ", ".join(sorted(str(item) for item in attached_groups))
    )

groups = {
    item.get("GroupId"): item
    for item in json.loads(os.environ["GROUPS_JSON"]).get("SecurityGroups", [])
}
expected_sources = set(os.environ["EXPECTED_SOURCE_GROUP_IDS"].split())
expected_group_ids = expected_sources | {db_group_id}
if set(groups) != expected_group_ids:
    missing = sorted(expected_group_ids - set(groups))
    extra = sorted(set(groups) - expected_group_ids)
    raise SystemExit(f"Security-group lookup mismatch; missing={missing} extra={extra}")

db_vpc = db.get("DBSubnetGroup", {}).get("VpcId")
if not db_vpc or any(group.get("VpcId") != db_vpc for group in groups.values()):
    raise SystemExit("RDS and every allowed source security group must share one VPC")

seen_sources = set()
public_rule_present = False
errors = []

def covers_postgres(permission):
    protocol = permission.get("IpProtocol")
    if protocol == "-1":
        return True
    if protocol != "tcp":
        return False
    start = permission.get("FromPort")
    end = permission.get("ToPort")
    return isinstance(start, int) and isinstance(end, int) and start <= 5432 <= end

for permission in groups[db_group_id].get("IpPermissions", []):
    if not covers_postgres(permission):
        continue

    protocol = permission.get("IpProtocol")
    exact_postgres_rule = (
        protocol == "tcp"
        and permission.get("FromPort") == 5432
        and permission.get("ToPort") == 5432
    )

    if protocol == "-1":
        broad_pairs = [
            pair.get("GroupId")
            for pair in permission.get("UserIdGroupPairs", [])
            if pair.get("GroupId") != db_group_id
        ]
        if broad_pairs:
            errors.append(
                "unexpected all-protocol security-group sources "
                + ", ".join(sorted(str(item) for item in broad_pairs))
            )
        for item in permission.get("IpRanges", []):
            errors.append(f"unexpected all-protocol IPv4 source {item.get('CidrIp')}")
        for item in permission.get("Ipv6Ranges", []):
            errors.append(f"unexpected all-protocol IPv6 source {item.get('CidrIpv6')}")
        for item in permission.get("PrefixListIds", []):
            errors.append(
                f"unexpected all-protocol prefix-list source {item.get('PrefixListId')}"
            )
        continue

    if not exact_postgres_rule:
        errors.append(
            "unexpected TCP port range covering Postgres "
            f"{permission.get('FromPort')}-{permission.get('ToPort')}"
        )
        continue

    for pair in permission.get("UserIdGroupPairs", []):
        source = pair.get("GroupId")
        if source in expected_sources:
            seen_sources.add(source)
        elif source != db_group_id:
            errors.append(f"unexpected security-group source {source}")

    for item in permission.get("IpRanges", []):
        cidr = item.get("CidrIp")
        if cidr == "0.0.0.0/0":
            public_rule_present = True
        else:
            errors.append(f"unexpected IPv4 source {cidr}")
    for item in permission.get("Ipv6Ranges", []):
        errors.append(f"unexpected IPv6 source {item.get('CidrIpv6')}")
    for item in permission.get("PrefixListIds", []):
        errors.append(f"unexpected prefix-list source {item.get('PrefixListId')}")

missing_sources = sorted(expected_sources - seen_sources)
if missing_sources:
    errors.append("missing required security-group sources " + ", ".join(missing_sources))

phase = os.environ["INSPECTION_PHASE"]
publicly_accessible = bool(db.get("PubliclyAccessible"))
if phase == "final":
    if publicly_accessible:
        errors.append("RDS is still publicly accessible")
    if public_rule_present:
        errors.append("the 0.0.0.0/0 Postgres rule is still present")

if errors:
    raise SystemExit("RDS perimeter check failed: " + "; ".join(errors))

print(f"{int(publicly_accessible)} {int(public_rule_present)}")
PY
}

if [[ "$mode" == "--check" ]]; then
  inspect_perimeter final >/dev/null
  echo "RDS perimeter check passed: $RDS_INSTANCE_ID is private with only reviewed security-group access."
  exit 0
fi

read -r publicly_accessible public_rule_present <<< "$(inspect_perimeter preflight)"

if [[ "$public_rule_present" == "1" ]]; then
  echo "Revoking the historical 0.0.0.0/0 Postgres ingress rule..."
  aws ec2 revoke-security-group-ingress \
    --region "$AWS_DEFAULT_REGION" \
    --group-id "$RDS_SECURITY_GROUP_ID" \
    --protocol tcp \
    --port 5432 \
    --cidr 0.0.0.0/0 >/dev/null
fi

if [[ "$publicly_accessible" == "1" ]]; then
  echo "Making $RDS_INSTANCE_ID non-public..."
  aws rds modify-db-instance \
    --region "$AWS_DEFAULT_REGION" \
    --db-instance-identifier "$RDS_INSTANCE_ID" \
    --no-publicly-accessible \
    --apply-immediately >/dev/null
  wait_for_rds_private
fi

inspect_perimeter final >/dev/null
echo "RDS perimeter reconciled: $RDS_INSTANCE_ID is private with only reviewed security-group access."
