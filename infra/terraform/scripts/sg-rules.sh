#!/usr/bin/env bash
# sg-rules.sh — security group rules that exist in AWS but in no Terraform
# state: what the drift workflow adds to the plan.
#
# A plan sees what Terraform manages and nothing beside it. Every security
# group here manages its rules as separate aws_vpc_security_group_*_rule
# resources (modules/network/security_groups.tf), so a rule added in the
# console belongs to no resource and no plan shows it, while a managed rule
# that was edited or deleted does show. Rules of one group can be managed by
# another stack (20-data adds rules to groups of 10-network), so whether a
# rule is managed is decided per environment, across all of its stacks.
#
#   sg-rules.sh managed <plan.json>
#       From the state the plan was made against (prior_state): the managed
#       security groups and the ids of the managed rules, as
#       {"groups": [sg id], "rules": [sgr id]}. Reads no value of a rule.
#
#   sg-rules.sh live <managed.json>
#       Asks AWS (ec2:DescribeSecurityGroupRules, read-only) for every rule
#       of those groups: [{"id", "group", "egress"}]. No AWS call when there
#       is no group.
#
#   sg-rules.sh unmanaged <live.json> <managed.json>...
#       The live rules whose id is in none of the managed sets.
#
# Ids only, never a port or an address range: the output goes into an issue.
# exit: 0, 1 when the input is not what is expected or AWS fails, 2 on a
#       usage error.
set -euo pipefail

usage() {
  echo "usage: sg-rules.sh managed <plan.json> | live <managed.json> | unmanaged <live.json> <managed.json>..." >&2
  exit 2
}
fail() {
  echo "sg-rules.sh: $*" >&2
  exit 1
}

[ "$#" -ge 2 ] || usage
command=$1
shift
for file in "$@"; do
  [ -f "$file" ] || { echo "sg-rules.sh: no such file: $file" >&2; exit 2; }
done

case "$command" in
  managed)
    [ "$#" -eq 1 ] || usage
    jq -e 'type == "object" and has("format_version")' "$1" > /dev/null 2>&1 ||
      fail "$1 is not the JSON of a plan (terraform show -json)"
    jq -c '
      def modules: ., (.child_modules[]? | modules);
      [.prior_state.values.root_module // {} | modules | .resources[]? | select(.mode == "managed")] as $rs
      | {
          groups: [$rs[] | select(.type == "aws_security_group") | .values.id] | unique,
          rules: [$rs[] | select(.type == "aws_vpc_security_group_ingress_rule" or .type == "aws_vpc_security_group_egress_rule")
                  | .values.security_group_rule_id] | unique
        }' "$1"
    ;;
  live)
    [ "$#" -eq 1 ] || usage
    jq -e '(.groups | type) == "array" and all(.groups[]; type == "string" and test("^sg-[0-9a-zA-Z]+$"))' "$1" > /dev/null 2>&1 ||
      fail "$1 is not the output of sg-rules.sh managed"
    mapfile -t groups < <(jq -r '.groups[]' "$1")
    pages=()
    # A filter takes a bounded number of values, so ask for 100 groups at a time.
    for ((i = 0; i < ${#groups[@]}; i += 100)); do
      values=$(IFS=,; echo "${groups[*]:i:100}")
      pages+=("$(aws ec2 describe-security-group-rules --filters "Name=group-id,Values=$values" --output json)") ||
        fail "aws ec2 describe-security-group-rules failed"
    done
    printf '%s\n' "${pages[@]}" | jq -sc '
      [.[].SecurityGroupRules[] | {id: .SecurityGroupRuleId, group: .GroupId, egress: .IsEgress}]
      | sort_by(.group, .id)'
    ;;
  unmanaged)
    [ "$#" -ge 2 ] || usage
    live=$1
    shift
    jq -e 'type == "array" and all(.[]; (.id | type) == "string")' "$live" > /dev/null 2>&1 ||
      fail "$live is not the output of sg-rules.sh live"
    for file in "$@"; do
      jq -e '(.rules | type) == "array"' "$file" > /dev/null 2>&1 || fail "$file is not the output of sg-rules.sh managed"
    done
    jq -c --slurpfile live "$live" -n '
      ([inputs.rules[]] | unique) as $managed
      | [$live[0][] | select(.id as $id | $managed | index($id) | not)] | sort_by(.group, .id)' "$@"
    ;;
  *) usage ;;
esac
