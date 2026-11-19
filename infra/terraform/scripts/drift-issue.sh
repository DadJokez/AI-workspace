#!/usr/bin/env bash
# drift-issue.sh — what the drift workflow concludes for one environment, and
# the issue it opens, refreshes or closes.
#
#   drift-issue.sh evaluate <env> <reports dir> <stack>...
#       Reads <reports dir>/drift-<env>-<stack>/ for each stack the
#       environment has: result.json ({outcome: clean|drift|failed}),
#       sg-managed.json and sg-live.json (sg-rules.sh). A stack without a
#       result failed. Prints
#         {env, status, stacks: [{stack, outcome}], rules_checked,
#          unmanaged_rules: [{id, group, egress}]}
#       status: `drift` when a stack has drift or a security group has a rule
#       no stack manages; `clean` when every stack planned with no changes and
#       the rules were checked; `unknown` otherwise (a plan failed and nothing
#       else drifted). Rules are checked only when every stack planned: a rule
#       is managed when any stack of the environment manages it.
#
#   drift-issue.sh deadline <first reported>
#       When the drift must be reconciled into Git (docs/runbooks/BREAK_GLASS.md:
#       within one working day): 00:00 UTC of the working day after the day it
#       was first reported, a report on a Saturday or Sunday counting from
#       Monday. Working days are Monday to Friday; holidays are not known.
#
#   drift-issue.sh overdue <first reported> <now>
#       `true` when <now> is at or past the deadline, else `false`.
#
#   drift-issue.sh body <evaluation.json> <reports dir> <first reported> <now> <run url>
#       The issue body (Markdown). Its first line is the marker the workflow
#       finds the issue by. Totals by resource type, stack names and rule ids
#       only: never a value or an address.
#
# Times are UTC, YYYY-MM-DDTHH:MM:SSZ.
# exit: 0, 1 when an input is not what is expected, 2 on a usage error.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

usage() {
  echo "usage: drift-issue.sh evaluate <env> <reports dir> <stack>... | deadline <time> | overdue <time> <now> | body <evaluation.json> <reports dir> <time> <now> <run url>" >&2
  exit 2
}
fail() {
  echo "drift-issue.sh: $*" >&2
  exit 1
}
# Date arithmetic in jq, the same with GNU and BSD tools. A time is valid when
# it reads back unchanged, which also refuses a day such as February 30.
time_arg() { # value
  if ! [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    ! jq -en --arg t "$1" '($t | fromdateiso8601 | todate) == $t' > /dev/null 2>&1; then
    echo "drift-issue.sh: not a UTC time (YYYY-MM-DDTHH:MM:SSZ): $1" >&2
    exit 2
  fi
}

# shellcheck disable=SC2016 # $t is jq's
deadline_jq='
  def weekend: (gmtime | .[6]) as $day | $day == 0 or $day == 6;
  def working_day: until(weekend | not; . + 86400);
  ($t | fromdateiso8601) as $s
  | $s - ($s % 86400) | working_day | . + 86400 | working_day'
deadline() { # first reported
  jq -nr --arg t "$1" "$deadline_jq | todate"
}
overdue() { # first reported, now
  jq -nr --arg t "$1" --arg now "$2" "($deadline_jq) as \$due | \$now | fromdateiso8601 >= \$due"
}

[ "$#" -ge 1 ] || usage
command=$1
shift

case "$command" in
  evaluate)
    [ "$#" -ge 3 ] || usage
    env_name=$1 reports=$2
    shift 2
    [[ "$env_name" =~ ^[a-z0-9-]+$ ]] || usage
    [ -d "$reports" ] || { echo "drift-issue.sh: no reports directory $reports" >&2; exit 2; }
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT

    : > "$tmp/stacks.jsonl"
    rules_checked=true
    managed=() live=()
    for stack in "$@"; do
      [[ "$stack" =~ ^[0-9]{2}-[a-z0-9-]+$ ]] || usage
      dir="$reports/drift-$env_name-$stack"
      outcome=$(jq -r '.outcome // ""' "$dir/result.json" 2>/dev/null || true)
      case "$outcome" in
        clean | drift) ;;
        *) outcome=failed ;;
      esac
      jq -nc --arg stack "$stack" --arg outcome "$outcome" '{stack: $stack, outcome: $outcome}' >> "$tmp/stacks.jsonl"
      if [ "$outcome" = failed ] || [ ! -f "$dir/sg-managed.json" ] || [ ! -f "$dir/sg-live.json" ]; then
        rules_checked=false
      else
        managed+=("$dir/sg-managed.json")
        live+=("$dir/sg-live.json")
      fi
    done

    echo '[]' > "$tmp/unmanaged.json"
    if [ "$rules_checked" = true ]; then
      jq -s 'add | unique_by(.id)' "${live[@]}" > "$tmp/live.json" || fail "a sg-live.json is not readable"
      "$here/sg-rules.sh" unmanaged "$tmp/live.json" "${managed[@]}" > "$tmp/unmanaged.json"
    fi

    jq -nc --arg env "$env_name" --argjson rules_checked "$rules_checked" \
      --slurpfile stacks "$tmp/stacks.jsonl" --slurpfile unmanaged "$tmp/unmanaged.json" '
      $stacks as $s | $unmanaged[0] as $u
      | {
          env: $env,
          status: (
            if any($s[]; .outcome == "drift") or ($u | length) > 0 then "drift"
            elif all($s[]; .outcome == "clean") and $rules_checked then "clean"
            else "unknown" end),
          stacks: $s,
          rules_checked: $rules_checked,
          unmanaged_rules: $u
        }'
    ;;
  deadline)
    [ "$#" -eq 1 ] || usage
    time_arg "$1"
    deadline "$1"
    ;;
  overdue)
    [ "$#" -eq 2 ] || usage
    time_arg "$1"
    time_arg "$2"
    overdue "$1" "$2"
    ;;
  body)
    [ "$#" -eq 5 ] || usage
    evaluation=$1 reports=$2 first=$3 now=$4 run_url=$5
    [ -f "$evaluation" ] || usage
    [ -d "$reports" ] || usage
    time_arg "$first"
    time_arg "$now"
    [[ "$run_url" =~ ^https://[A-Za-z0-9./_-]+$ ]] || usage
    jq -e '(.env | test("^[a-z0-9-]+$")) and (.status | type) == "string" and (.stacks | type) == "array"' "$evaluation" > /dev/null 2>&1 ||
      fail "$evaluation is not the output of drift-issue.sh evaluate"
    env_name=$(jq -r .env "$evaluation")
    due=$(deadline "$first")
    late=$(overdue "$first" "$now")

    echo "<!-- terraform-drift:$env_name -->"
    echo "### Terraform drift: \`$env_name\`"
    echo
    echo "What runs in AWS differs from \`main\`. Found by the [drift run]($run_url) of $now, with the read-only plan role and no state lock; values are not shown."
    echo
    if [ "$late" = true ]; then
      echo "**Overdue.** First reported $first; it had to be reconciled into Git by $due."
    else
      echo "First reported $first. **Reconcile into Git by $due.**"
    fi
    echo "Every change made outside the pipeline must be in Git within one working day: [break-glass runbook](${run_url%%/actions/runs/*}/blob/main/docs/runbooks/BREAK_GLASS.md)."
    echo
    echo "| Stack | Result |"
    echo "|---|---|"
    while IFS=$'\t' read -r stack outcome; do
      dir="$reports/drift-$env_name-$stack"
      case "$outcome" in
        clean) echo "| \`$stack\` | no drift |" ;;
        drift) echo "| \`$stack\` | **drift**: $(head -n 1 "$dir/summary.md" 2>/dev/null | tr '|' '/') |" ;;
        *) echo "| \`$stack\` | **plan failed**, so its drift is unknown; see the run |" ;;
      esac
    done < <(jq -r '.stacks[] | [.stack, .outcome] | @tsv' "$evaluation")
    echo
    if [ "$(jq -r .rules_checked "$evaluation")" != true ]; then
      echo "Security group rules outside Terraform: **not checked**, because a plan of this environment failed."
    elif [ "$(jq '.unmanaged_rules | length' "$evaluation")" = 0 ]; then
      echo "Security group rules outside Terraform: none."
    else
      echo "Security group rules that no stack manages (a plan cannot show these; \`aws ec2 describe-security-group-rules --security-group-rule-ids <id>\` shows one):"
      echo
      # shellcheck disable=SC2016 # the backticks are Markdown, not a command
      jq -r '.unmanaged_rules[] | "- `\(.id)` on `\(.group)` (\(if .egress then "egress" else "ingress" end))"' "$evaluation"
    fi
    while IFS= read -r stack; do
      dir="$reports/drift-$env_name-$stack"
      echo
      echo "<details><summary><code>$stack</code> by resource type</summary>"
      echo
      cat "$dir/outside.md" 2>/dev/null || echo "What changed outside Terraform was not reported."
      echo
      echo "What an apply of \`main\` would do:"
      echo
      cat "$dir/summary.md" 2>/dev/null || echo "Not reported."
      echo
      echo "</details>"
    done < <(jq -r '.stacks[] | select(.outcome == "drift") | .stack' "$evaluation")
    echo
    echo "**To close this issue**, make \`main\` and AWS agree: put the change into Git with a pull request, or undo it in AWS (a security group rule outside Terraform is added to the configuration or deleted). The next drift run closes this issue when every stack of \`$env_name\` plans with no changes; run **Terraform Drift** by hand to check sooner."
    ;;
  *) usage ;;
esac
