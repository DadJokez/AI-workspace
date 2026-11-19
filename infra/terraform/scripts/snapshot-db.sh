#!/usr/bin/env bash
# snapshot-db.sh <env> — the recovery point taken before a release migrates
# the database. Ported from infra/scripts/snapshot-rds-before-migrate.sh.
#
# Takes the manual snapshot pre-migrate-<first 12 of RELEASE_ID>-<RUN_ID> of
# the environment's database, waits until it is available, and checks that it
# is encrypted and of that instance. Then deletes the earlier pre-migrate-
# snapshots of the instance that are older than snapshot_keep_days; a failed
# deletion is reported but does not fail the step, the new snapshot does.
#
# Reads, under /comparative/<env>/: 20-data/db/instance_id and
# 35-deploy-tasks/snapshot_keep_days.
#
# Environment: AWS_REGION, RELEASE_ID (full commit sha), RUN_ID (the workflow
# run id and attempt, <digits>-<digits>, so a re-run takes its own snapshot).
#
# stdout: `Snapshot receipt: {"snapshot_id", "db_instance_id", "release_id",
#         "encrypted", "pruned": [...]}`.
# exit:   0 with a verified snapshot; 1 otherwise; 2 on a usage error.
set -euo pipefail

usage() {
  echo "usage: snapshot-db.sh <env>" >&2
  exit 2
}
[ "$#" -eq 1 ] || usage
env_name=$1
[[ "$env_name" =~ ^[a-z0-9-]+$ ]] || usage

: "${AWS_REGION:?AWS_REGION is required}"
: "${RELEASE_ID:?RELEASE_ID is required}"
: "${RUN_ID:?RUN_ID is required}"
[[ "$RELEASE_ID" =~ ^[0-9a-f]{40}$ ]] || { echo "snapshot-db.sh: RELEASE_ID is not a full commit sha" >&2; exit 2; }
[[ "$RUN_ID" =~ ^[0-9]+-[0-9]+$ ]] || { echo "snapshot-db.sh: RUN_ID is not <run id>-<attempt>" >&2; exit 2; }

fail() {
  echo "snapshot-db.sh: $*" >&2
  exit 1
}

prefix="/comparative/$env_name"
instance_name="$prefix/20-data/db/instance_id"
keep_name="$prefix/35-deploy-tasks/snapshot_keep_days"
parameters=$(aws ssm get-parameters --region "$AWS_REGION" --output json --names "$instance_name" "$keep_name")
missing=$(jq -r '.InvalidParameters // [] | join(", ")' <<<"$parameters")
[ -z "$missing" ] || fail "SSM parameters not found: $missing"
value() {
  jq -r --arg n "$1" '[.Parameters[] | select(.Name == $n) | .Value] | if length == 1 then .[0] else empty end' <<<"$parameters"
}
db_instance=$(value "$instance_name")
keep_days=$(value "$keep_name")
[[ "$db_instance" =~ ^[a-zA-Z][a-zA-Z0-9-]*$ ]] || fail "$instance_name is not a database instance identifier"
[[ "$keep_days" =~ ^[1-9][0-9]*$ ]] || fail "$keep_name is not a whole number of days"

snapshot_id="pre-migrate-${RELEASE_ID:0:12}-$RUN_ID"

aws rds create-db-snapshot --region "$AWS_REGION" \
  --db-instance-identifier "$db_instance" \
  --db-snapshot-identifier "$snapshot_id" \
  --tags "Key=release_id,Value=$RELEASE_ID" "Key=purpose,Value=pre-migrate" \
  --output json >/dev/null

echo "Waiting for $snapshot_id ..."
aws rds wait db-snapshot-available --region "$AWS_REGION" --db-snapshot-identifier "$snapshot_id"

described=$(aws rds describe-db-snapshots --region "$AWS_REGION" --output json --db-snapshot-identifier "$snapshot_id")
jq -e --arg id "$snapshot_id" --arg db "$db_instance" '
  (.DBSnapshots | length) == 1
  and (.DBSnapshots[0] | .Status == "available" and .Encrypted == true
       and .DBSnapshotIdentifier == $id and .DBInstanceIdentifier == $db)' <<<"$described" >/dev/null 2>&1 ||
  fail "$snapshot_id is not an available, encrypted snapshot of $db_instance"

# Earlier recovery points of this instance, past their keep time.
pruned=()
if existing=$(aws rds describe-db-snapshots --region "$AWS_REGION" --output json \
  --db-instance-identifier "$db_instance" --snapshot-type manual); then
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    if aws rds delete-db-snapshot --region "$AWS_REGION" --db-snapshot-identifier "$old" --output json >/dev/null; then
      pruned+=("$old")
    else
      echo "snapshot-db.sh: warning: could not delete $old; it is kept" >&2
    fi
  done < <(jq -r --arg new "$snapshot_id" --arg db "$db_instance" --argjson days "$keep_days" '
    def created: .SnapshotCreateTime // "" | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | try fromdateiso8601 catch null;
    (now - $days * 86400) as $cutoff
    | .DBSnapshots[]
    | select(.DBInstanceIdentifier == $db and .Status == "available"
             and (.DBSnapshotIdentifier | startswith("pre-migrate-")) and .DBSnapshotIdentifier != $new)
    | select((created // $cutoff) < $cutoff)
    | .DBSnapshotIdentifier' <<<"$existing")
else
  echo "snapshot-db.sh: warning: could not list the earlier snapshots; none deleted" >&2
fi

jq -nc --arg id "$snapshot_id" --arg db "$db_instance" --arg release "$RELEASE_ID" \
  '{snapshot_id: $id, db_instance_id: $db, release_id: $release, encrypted: true, pruned: $ARGS.positional}' \
  --args "${pruned[@]}" | sed 's/^/Snapshot receipt: /'
