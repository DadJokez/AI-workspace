#!/usr/bin/env bash
# plan-report.sh — what the plan and apply workflows read from a plan. Input
# is `terraform show -json <plan file>`.
#
#   plan-report.sh summary <plan.json>
#       Markdown: the totals and one row per resource type with the number to
#       add, change, replace, destroy and other actions (forget). Types and
#       counts only: never an address (a for_each key can be a configuration
#       value) and never a value. Safe for a pull-request comment.
#
#   plan-report.sh outside <plan.json>
#       Markdown like `summary`, of what Terraform found changed or deleted
#       outside Terraform since the state was written (resource_drift): the
#       drift workflow's issue shows it beside what an apply would do. Types
#       and counts only.
#
#   plan-report.sh changes <plan.json>
#       The number of managed resources and outputs the plan would change.
#       0 means there is nothing to apply.
#
#   plan-report.sh stateful <plan.json>
#       One line per resource holding data that the plan would destroy or
#       replace: `<address>\t<actions>`. Nothing when there is none.
#
#   plan-report.sh fingerprint <plan.json>
#       sha256 of what the plan would do: each changed managed resource
#       (address, actions, planned values, which values are unknown) and each
#       changed output, in a fixed order. Two plans with the same fingerprint
#       make the same changes, whatever the state looked like before or when
#       they were made.
#
# exit: 0, 1 when the input is not plan JSON, 2 on a usage error.
set -euo pipefail

# Resources whose destruction loses data or identity that cannot be recreated:
# a database, a key (and everything encrypted with it), a bucket, a secret, an
# image repository. Replacing one needs the label allow-stateful-replace.
stateful_types='["aws_db_instance", "aws_kms_key", "aws_s3_bucket", "aws_secretsmanager_secret", "aws_ecr_repository"]'

usage() {
  echo "usage: plan-report.sh <summary|outside|changes|stateful|fingerprint> <plan.json>" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
command=$1
plan=$2
[ -f "$plan" ] || { echo "plan-report.sh: no such file: $plan" >&2; exit 2; }
jq -e 'type == "object" and has("format_version")' "$plan" >/dev/null 2>&1 || {
  echo "plan-report.sh: $plan is not the JSON of a plan (terraform show -json)" >&2
  exit 1
}

# Changed managed resources, each with the one word for what happens to it.
defs='
  def kind:
    if . == ["create"] then "add"
    elif . == ["update"] then "change"
    elif . == ["delete"] then "destroy"
    elif (index("create") != null and index("delete") != null) then "replace"
    else "other" end;
  def changed_resources:
    [.resource_changes // [] | .[]
      | select(.mode == "managed" and .change.actions != ["no-op"] and .change.actions != ["read"])];
  def changed_outputs:
    [.output_changes // {} | to_entries[] | select(.value.actions != ["no-op"])];
'

case "$command" in
  summary)
    jq -r "$defs"'
      changed_resources as $rs
      | ($rs | map(.change.actions | kind)) as $kinds
      | def total($k): $kinds | map(select(. == $k)) | length;
      if ($rs | length) == 0 then
        "No changes to resources."
      else
        "**\(total("add")) to add, \(total("change")) to change, \(total("replace")) to replace, \(total("destroy")) to destroy**"
          + (if total("other") > 0 then " (and \(total("other")) other: forget)" else "" end),
        "",
        "| Resource type | Add | Change | Replace | Destroy | Other |",
        "|---|---:|---:|---:|---:|---:|",
        ($rs | group_by(.type)[]
          | (map(.change.actions | kind)) as $k
          | def n($x): $k | map(select(. == $x)) | length;
          "| `\(.[0].type)` | \(n("add")) | \(n("change")) | \(n("replace")) | \(n("destroy")) | \(n("other")) |")
      end' "$plan"
    ;;
  outside)
    jq -r '
      [.resource_drift // [] | .[] | select(.mode == "managed")] as $rs
      | def deleted: .change.actions == ["delete"];
      if ($rs | length) == 0 then
        "Nothing changed outside Terraform."
      else
        "**Changed outside Terraform: \($rs | map(select(deleted | not)) | length) changed, \($rs | map(select(deleted)) | length) deleted**",
        "",
        "| Resource type | Changed | Deleted |",
        "|---|---:|---:|",
        ($rs | group_by(.type)[]
          | "| `\(.[0].type)` | \(map(select(deleted | not)) | length) | \(map(select(deleted)) | length) |")
      end' "$plan"
    ;;
  changes)
    jq -r "$defs"'(changed_resources | length) + (changed_outputs | length)' "$plan"
    ;;
  stateful)
    jq -r --argjson types "$stateful_types" "$defs"'
      changed_resources[]
      | select((.type as $t | $types | index($t)) != null and (.change.actions | index("delete")) != null)
      | "\(.address)\t\(.change.actions | join(","))"' "$plan"
    ;;
  fingerprint)
    jq -S -c "$defs"'{
      resources: (changed_resources
        | map({address, actions: .change.actions, after: .change.after, after_unknown: .change.after_unknown})
        | sort_by(.address)),
      outputs: (changed_outputs
        | map({name: .key, actions: .value.actions, after: .value.after, after_unknown: .value.after_unknown})
        | sort_by(.name))
    }' "$plan" | sha256sum | cut -d' ' -f1
    ;;
  *) usage ;;
esac
