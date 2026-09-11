#!/usr/bin/env bash
set -euo pipefail

: "${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION is required}"
: "${COMMIT_TAG:?COMMIT_TAG is required}"
: "${CODEBUILD_BUILD_NUMBER:?CODEBUILD_BUILD_NUMBER is required}"
[[ "$COMMIT_TAG" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid commit SHA" >&2; exit 1; }
[[ "$CODEBUILD_BUILD_NUMBER" =~ ^[0-9]+$ ]] || { echo "Invalid build number" >&2; exit 1; }

# Each build gets its own recovery point, including retries of the same SHA.
snapshot_id="pre-migrate-${COMMIT_TAG:0:12}-${CODEBUILD_BUILD_NUMBER}"
database_id="ai-workspace-db"
aws rds create-db-snapshot --region "$AWS_DEFAULT_REGION" \
  --db-instance-identifier "$database_id" \
  --db-snapshot-identifier "$snapshot_id" \
  --tags "Key=CommitSha,Value=$COMMIT_TAG" "Key=Purpose,Value=pre-migrate" \
  --query 'DBSnapshot.DBSnapshotIdentifier' --output text >/dev/null

aws rds wait db-snapshot-available --region "$AWS_DEFAULT_REGION" \
  --db-snapshot-identifier "$snapshot_id"

snapshot_json=$(aws rds describe-db-snapshots --region "$AWS_DEFAULT_REGION" \
  --db-snapshot-identifier "$snapshot_id" --output json)
SNAPSHOT_JSON="$snapshot_json" SNAPSHOT_ID="$snapshot_id" DB_ID="$database_id" \
  COMMIT_TAG="$COMMIT_TAG" python3 <<'PY'
import json
import os

rows = json.loads(os.environ["SNAPSHOT_JSON"]).get("DBSnapshots", [])
if len(rows) != 1:
    raise SystemExit("Expected exactly one pre-migration snapshot")
snapshot = rows[0]
if (snapshot.get("Status") != "available"
        or snapshot.get("DBSnapshotIdentifier") != os.environ["SNAPSHOT_ID"]
        or snapshot.get("DBInstanceIdentifier") != os.environ["DB_ID"]
        or snapshot.get("Encrypted") is not True):
    raise SystemExit("Pre-migration snapshot is not available, encrypted, and scoped to the expected database")
print("Snapshot receipt: " + json.dumps({
    "kind": "pre-migrate-snapshot",
    "commitSha": os.environ["COMMIT_TAG"],
    "snapshotId": snapshot["DBSnapshotIdentifier"],
    "databaseId": snapshot["DBInstanceIdentifier"],
    "status": snapshot["Status"],
    "encrypted": True,
}, separators=(",", ":")))
PY
