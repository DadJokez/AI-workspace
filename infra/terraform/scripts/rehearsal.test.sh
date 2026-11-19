#!/usr/bin/env bash
# Fixtures for rehearsal.sh: the dry run CI runs, the order `up` applies in and
# where it stops, the tasks `run` starts, what `report` makes of the logs,
# what `down` destroys, and the allowlist generated from the egress inventory.
#
# Runs against a copy of tf.sh and the scripts in a throwaway tree, with
# stand-ins for `terraform`, `conftest`, `aws` and `pnpm`. No credentials, no
# state, no AWS calls.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
src=$(cd "$here/.." && pwd)
pass=0
fail=0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

ok() {
  echo "  ok   $1"
  pass=$((pass + 1))
}
bad() { # name detail
  echo "  FAIL $1"
  printf '%s\n' "$2" | sed 's/^/       /'
  fail=$((fail + 1))
}

stacks=(00-foundation 10-network 20-data 30-platform 35-deploy-tasks 50-agentcore 40-services 60-observability)
release=0123456789abcdef0123456789abcdef01234567

# --- the throwaway tree --------------------------------------------------------

root="$tmp/repo/infra/terraform"
env_dir="$root/envs/personal-rehearsal"
mkdir -p "$root/scripts/fixtures" "$root/policy" "$root/modules" "$env_dir" "$tmp/bin" "$tmp/state"
cp "$src/tf.sh" "$root/"
cp "$here"/{rehearsal.sh,rehearsal-report.jq,rehearsal-markdown.jq,stack.sh,plan-report.sh,placeholders.sh,run-task.sh} "$root/scripts/"
cp -R "$here/fixtures/rehearsal" "$root/scripts/fixtures/rehearsal"
for stack in "${stacks[@]}"; do
  mkdir -p "$root/stacks/$stack"
  touch "$root/stacks/$stack/main.tf" "$root/stacks/$stack/.terraform.lock.hcl"
done
script="$root/scripts/rehearsal.sh"

# The committed files, placeholders and all (what --plan-only and allowlist
# read), and filled-in copies (what a human runs up, run and down with).
committed_env() { cp "$src/envs/personal-rehearsal"/* "$env_dir/"; }
filled_env() {
  committed_env
  sed -i 's/REPLACE_ME[A-Z_]*/filled/g' "$env_dir/env.tfvars" "$env_dir/backend.hcl"
  printf 'release_id = "%s"\n' "$release" >"$env_dir/release.auto.tfvars"
}

# What the stacks publish, for the stand-in `aws`.
cat >"$tmp/ssm.json" <<'EOF'
{
  "/comparative/personal-rehearsal/30-platform/cluster_arn": "arn:aws:ecs:us-east-1:111122223333:cluster/cmp-personal-rehearsal-cluster",
  "/comparative/personal-rehearsal/30-platform/alb_dns_name": "internal-cmp-personal-rehearsal-alb-42.us-east-1.elb.amazonaws.com",
  "/comparative/personal-rehearsal/10-network/vpc_id": "vpc-0aaaaaaaaaaaaaaaa",
  "/comparative/personal-rehearsal/10-network/app_subnet_ids": "[\"subnet-a\",\"subnet-b\"]",
  "/comparative/personal-rehearsal/10-network/sg/deploy_task_id": "sg-deploy",
  "/comparative/personal-rehearsal/35-deploy-tasks/taskdef/migrator_arn": "arn:aws:ecs:us-east-1:111122223333:task-definition/cmp-personal-rehearsal-migrator:1",
  "/comparative/personal-rehearsal/35-deploy-tasks/taskdef/smoke_arn": "arn:aws:ecs:us-east-1:111122223333:task-definition/cmp-personal-rehearsal-smoke:1",
  "/comparative/personal-rehearsal/40-services/service/chat_worker_name": "cmp-personal-rehearsal-chat-worker"
}
EOF

# --- stand-ins ------------------------------------------------------------------

# terraform: `test` prints $FAKE_TEST_JSONL, `plan -out=F` writes the path of
# $FAKE_PLAN into F, `show -json F` prints that plan. Every call is logged.
cat >"$tmp/bin/terraform" <<'EOF'
#!/usr/bin/env bash
echo "terraform $*" >> "$FAKE_LOG"
shift # -chdir
case "$1" in
  init) exit 0 ;;
  test) cat "$FAKE_TEST_JSONL"; exit "${FAKE_TEST_EXIT:-0}" ;;
  plan)
    for arg in "$@"; do
      case "$arg" in -out=*) echo "$FAKE_PLAN" > "${arg#-out=}" ;; esac
    done
    ;;
  show) cat "$(cat "${@: -1}")" ;;
  apply | destroy) exit 0 ;;
  *) echo "unexpected terraform $*" >&2; exit 99 ;;
esac
EOF
cat >"$tmp/bin/conftest" <<'EOF'
#!/usr/bin/env bash
echo "conftest $*" >> "$FAKE_LOG"
if [ -n "${FAKE_POLICY_FAILURE:-}" ]; then
  if [[ " $* " == *" --output json "* ]]; then
    jq -n --arg m "$FAKE_POLICY_FAILURE" '[{filename: "plan.json", failures: [{msg: $m}]}]'
  else
    echo "FAIL - plan.json - main - $FAKE_POLICY_FAILURE"
  fi
  exit 1
fi
if [[ " $* " == *" --output json "* ]]; then echo '[{"filename": "plan.json", "successes": 8}]'; fi
EOF
# aws: answers from ssm.json and the FAKE_* settings. A task exits with
# $FAKE_TASK_EXIT, or 1 when its run-task arguments contain $FAKE_FAIL_MATCH.
cat >"$tmp/bin/aws" <<'EOF'
#!/usr/bin/env bash
printf 'aws %s\n' "$*" >> "$FAKE_LOG"
arg() { # the value after flag $1
  local flag=$1; shift
  while [ "$#" -gt 0 ]; do [ "$1" = "$flag" ] && { echo "$2"; return; }; shift; done
}
case "$1 $2" in
  "ssm get-parameter")
    jq -er --arg n "$(arg --name "$@")" '.[$n] // error("ParameterNotFound \($n)")' "$FAKE_SSM" ;;
  "ssm get-parameters")
    shift 2; names=()
    while [ "$#" -gt 0 ]; do
      case "$1" in --names) shift; while [ "$#" -gt 0 ] && [[ "$1" != --* ]]; do names+=("$1"); shift; done ;; *) shift ;; esac
    done
    printf '%s\n' "${names[@]}" | jq -R . | jq -s --slurpfile p "$FAKE_SSM" \
      '{Parameters: [.[] | select($p[0][.] != null) | {Name: ., Value: $p[0][.]}], InvalidParameters: [.[] | select($p[0][.] == null)]}' ;;
  "secretsmanager describe-secret")
    if [ "${FAKE_SECRETS_READY:-0}" = 1 ]; then echo '{"VersionIdsToStages": {"v1": ["AWSCURRENT"]}}'; else echo '{}'; fi ;;
  "ecs run-task")
    code=${FAKE_TASK_EXIT:-0}
    if [ -n "${FAKE_FAIL_MATCH:-}" ] && [[ "$*" == *"$FAKE_FAIL_MATCH"* ]]; then code=1; fi
    echo "$code" > "$FAKE_STATE/exit"
    echo '{"tasks": [{"taskArn": "arn:aws:ecs:us-east-1:111122223333:task/cmp/abc"}], "failures": []}' ;;
  "ecs wait") ;;
  "ecs describe-tasks")
    jq -n --argjson code "$(cat "$FAKE_STATE/exit")" '{tasks: [{taskArn: "arn:aws:ecs:us-east-1:111122223333:task/cmp/abc",
      taskDefinitionArn: "arn:aws:ecs:us-east-1:111122223333:task-definition/cmp-personal-rehearsal-smoke:1",
      containers: [{name: "smoke", exitCode: $code}]}]}' ;;
  "ecs describe-services") echo "arn:aws:ecs:us-east-1:111122223333:task-definition/cmp-personal-rehearsal-chat-worker:3" ;;
  "ecs describe-task-definition") echo "arn:aws:iam::111122223333:role/comparative/personal-rehearsal/cmp-personal-rehearsal-chat-worker-task" ;;
  "ec2 describe-vpcs") echo "10.65.0.0/16" ;;
  "ec2 describe-subnets") echo '["10.65.0.0/20", "10.65.16.0/20"]' ;;
  "ec2 describe-managed-prefix-lists") echo "pl-0123456789abcdef0" ;;
  "ec2 get-managed-prefix-list-entries") echo '["52.216.0.0/15"]' ;;
  "logs filter-log-events")
    case "$(arg --log-group-name "$@")" in
      */standin-proxy) cat "$FAKE_PROXY_LOG" ;;
      */vpc-flow-logs) cat "$FAKE_FLOW_LOG" ;;
      *) exit 99 ;;
    esac ;;
  *) echo "unexpected aws $*" >&2; exit 99 ;;
esac
EOF
# pnpm: records its environment and prints the allowlist JSON of the current
# run. rehearsal.sh calls it with a cleared environment, so it takes its
# settings from files of the state directory, not from FAKE_* variables.
cat >"$tmp/bin/pnpm" <<EOF
#!/usr/bin/env bash
echo "pnpm \$*" >> "\$(cat "$tmp/state/log")"
env | LC_ALL=C sort > "$tmp/state/pnpm.env"
cat "\$(cat "$tmp/state/allowlist")"
EOF
chmod +x "$tmp/bin"/*

# A plan that only creates: the plan-report fixture without its stateful
# resources, as stack.test.sh makes it.
jq '.resource_changes |= map(select(.type != "aws_db_instance" and .type != "aws_s3_bucket" and .type != "aws_ecr_repository"))' \
  "$here/fixtures/plan-report/mixed.json" >"$tmp/stateless.json"

# What `terraform test -json -verbose` prints for one mocked run: a
# diagnostic, and the plan with tags_all as the mocked provider leaves it.
cat >"$tmp/test.jsonl" <<'EOF'
{"@level":"info","@message":"Found 1 file and 1 run block","type":"test_abstract"}
{"type":"test_plan","@testrun":"rehearsal","test_plan":{"plan_format_version":"1.2","resource_changes":[{"address":"aws_vpc.this[0]","mode":"managed","type":"aws_vpc","name":"this","change":{"actions":["create"],"after":{"cidr_block":"10.65.0.0/16","tags":{"Name":"cmp-personal-rehearsal"},"tags_all":{}},"after_unknown":{"id":true}}}]}}
EOF

n=0
# run <rehearsal.sh args...>; sets $status, $output, $log
run() {
  n=$((n + 1))
  log="$tmp/log$n"
  : >"$log"
  echo "$log" >"$tmp/state/log"
  echo "${FAKE_ALLOWLIST:-$here/fixtures/rehearsal/egress-allowlist.json}" >"$tmp/state/allowlist"
  output=$(env PATH="$tmp/bin:$PATH" FAKE_LOG="$log" FAKE_STATE="$tmp/state" FAKE_SSM="$tmp/ssm.json" \
    FAKE_PLAN="$tmp/stateless.json" FAKE_TEST_JSONL="$tmp/test.jsonl" \
    REHEARSAL_DIR="$tmp/work" AWS_REGION=us-east-1 \
    bash "$script" "$@" 2>&1)
  status=$?
}
expect() { # name condition-command...
  local name=$1
  shift
  if "$@"; then ok "$name"; else bad "$name" "exit $status
$output
log:
$(head -c 4000 "$log" 2>/dev/null)"; fi
}
logged() { grep -q -- "$1" "$log"; }
not_logged() { ! grep -q -- "$1" "$log"; }
says() { grep -q -- "$1" <<<"$output"; }
# The order in which the log names the stacks, for lines matching $1.
stack_order() {
  grep -- "$1" "$log" | sed -n 's|.*/stacks/\([0-9][0-9]-[a-z-]*\).*|\1|p' | paste -sd ' '
}

echo "plan-only (what CI runs):"

committed_env
run --plan-only
expect "the dry run passes" test "$status" = 0
expect "it plans every stack, in the apply order" \
  test "$(stack_order 'test -test-directory=rehearsal')" = "${stacks[*]}"
expect "each plan reads env.tfvars, then the stand-ins" \
  logged "test -test-directory=rehearsal -json -verbose -var-file=$env_dir/env.tfvars -var-file=$root/scripts/fixtures/rehearsal/plan-only.tfvars"
expect "each plan is checked by the Conftest rules" test "$(grep -c "^conftest test --policy $root/policy" "$log")" = 8
expect "the tags the provider would merge reach the plan Conftest reads" test \
  "$(jq -c '.resource_changes[0].change.after.tags_all | {owner, env, Name}' "$tmp/work/plan-only/40-services/plan.json")" = \
  '{"owner":"plan-only","env":"personal-rehearsal","Name":"cmp-personal-rehearsal"}'
expect "it prints the command of every automated check" \
  test "$(grep -c 'run-task.sh personal-rehearsal smoke' <<<"$output")" = 3
expect "the eval gate runs as the chat-worker's task role" says '"command":\["pnpm","eval","--gate"\]'
expect "it says which checks are not run" test "$(grep -c 'not run: no entry point' <<<"$output")" = 4
expect "it prints the destroy order" says "tf.sh personal-rehearsal 00-foundation destroy"
expect "it calls no AWS" not_logged "^aws "
expect "it never plans for real, applies or destroys" bash -c "! grep -Eq ' (plan|apply|destroy)( |$)' '$log'"

FAKE_TEST_EXIT=1 run --plan-only up
expect "a stack that does not plan fails the dry run" test "$status" = 1 -a -n "$(says 'does not plan with envs/personal-rehearsal' && echo y)"

FAKE_POLICY_FAILURE="[sg-no-open-ingress] aws_vpc_security_group_ingress_rule.web is open" run --plan-only up
expect "a plan a rule rejects fails the dry run" test "$status" = 1 -a -n "$(says 'rejects the plan of 00-foundation' && echo y)"
expect "it still plans the other stacks" test "$(grep -c 'test -test-directory' "$log")" = 8

printf 'new_setting = "REPLACE_ME_NEW"\n' >>"$env_dir/env.tfvars"
run --plan-only up
expect "a placeholder without a stand-in is refused before planning" \
  test "$status" = 1 -a -n "$(says 'no stand-in for: new_setting' && echo y)"
expect "nothing is planned then" not_logged "terraform"

echo "up:"

filled_env
printf '# release_id = "%s"\n' "$release" >"$env_dir/release.auto.tfvars"
run up
expect "up without a release is refused before AWS" test "$status" = 1 -a ! -s "$log"

filled_env
run up
expect "up stops after 20-data until the secrets have values" test "$status" = 3
expect "it says what to do" says "After the first apply of 20-data"
expect "it applied 00 to 20 only" test "$(stack_order ' apply ')" = "00-foundation 10-network 20-data"

FAKE_SECRETS_READY=1 run up
expect "up with the secrets written applies every stack" test "$status" = 0
expect "in the apply order" test "$(stack_order ' apply ')" = "${stacks[*]}"
expect "each apply is the saved plan of stack.sh" logged "apply -input=false $tmp/work/up/40-services/plan.tfplan"
expect "it writes the internal load balancer's URL into env.tfvars" \
  grep -qx 'internal_base_url = "https://internal-cmp-personal-rehearsal-alb-42.us-east-1.elb.amazonaws.com"' "$env_dir/env.tfvars"
migrator_line=$(grep -n 'ecs run-task.*migrator' "$log" | cut -d: -f1)
apply35=$(grep -n 'stacks/35-deploy-tasks apply' "$log" | cut -d: -f1)
apply50=$(grep -n 'stacks/50-agentcore apply' "$log" | cut -d: -f1)
expect "the migrator runs after 35-deploy-tasks and before 50-agentcore" \
  test -n "$migrator_line" -a "${migrator_line:-0}" -gt "${apply35:-0}" -a "${migrator_line:-0}" -lt "${apply50:-0}"

echo "run:"

filled_env
run run
expect "run needs REHEARSAL_EMAIL" test "$status" = 1 -a -n "$(says REHEARSAL_EMAIL && echo y)"

REHEARSAL_EMAIL=rehearsal@example.com run run
expect "run passes when every task exits 0" test "$status" = 0
expect "three tasks run, all from the smoke task definition" \
  test "$(grep -c 'ecs run-task.*task-definition/cmp-personal-rehearsal-smoke:1' "$log")" = 3
expect "the smoke runs as it is, the others with overrides" \
  test "$(grep 'ecs run-task' "$log" | grep -vc -- --overrides)" = 1
expect "the magic-link check runs first, while any address may ask for a link" \
  bash -c "grep 'ecs run-task' '$log' | head -n 1 | grep -q REHEARSAL_EMAIL"
expect "the eval gate runs as the chat-worker's role" \
  logged '"taskRoleArn":"arn:aws:iam::111122223333:role/comparative/personal-rehearsal/cmp-personal-rehearsal-chat-worker-task"'
expect "the magic-link check gets the address" logged '"name":"REHEARSAL_EMAIL","value":"rehearsal@example.com"'
expect "the results record four checks as not run" \
  test "$(jq -r '[.checks[] | .status] | join(" ")' "$tmp/work/run.json")" = "pass pass pass not_run not_run not_run not_run"
expect "the results carry the release and the window" \
  jq -e --arg r "$release" '.release_id == $r and .finished_at >= .started_at' "$tmp/work/run.json"

REHEARSAL_EMAIL=rehearsal@example.com FAKE_FAIL_MATCH='"pnpm","eval"' run run
expect "a failed check fails run" test "$status" = 1
expect "the other checks still run" \
  test "$(jq -r '[.checks[] | .status] | join(" ")' "$tmp/work/run.json")" = "pass pass fail not_run not_run not_run not_run"
expect "the failure says why" jq -e '.checks[2].detail | test("exit code 1")' "$tmp/work/run.json"

echo "report:"

run_json() { # magic-link status
  jq -n --arg r "$release" --arg m "$1" '{env: "personal-rehearsal", release_id: $r, started_at: 1795000000, finished_at: 1795000300,
    checks: [{id: "smoke", name: "Smoke", status: "pass", detail: "task exited 0"},
             {id: "eval-gate", name: "Eval gate", status: "pass", detail: "task exited 0"},
             {id: "studio-browser", name: "Browser", status: "not_run", detail: "no entry point"},
             {id: "magic-link", name: "Magic link", status: $m, detail: "task exited 0"}]}' >"$tmp/work/run.json"
}
jq -n '[
  "1795000010.123    250 10.65.0.10 TCP_TUNNEL/200 5120 CONNECT email.us-east-1.amazonaws.com:443 - HIER_DIRECT/52.0.0.1 -",
  "1795000011.456     12 10.65.0.11 TCP_DENIED/403 3800 CONNECT api.search.brave.com:443 - HIER_NONE/- text/html",
  "1795000012.789    300 10.65.0.12 TCP_TUNNEL/200 6100 CONNECT api.github.com:443 - HIER_DIRECT/140.82.112.6 -",
  "1795000013.000    300 10.65.0.12 TCP_TUNNEL/200 6100 CONNECT eu12.salesforce.com:443 - HIER_DIRECT/1.2.3.4 -",
  "2026/11/18 11:06:41| Starting Squid Cache version 6.6"
]' >"$tmp/proxy.json"
jq -n '[
  "2 111122223333 eni-0aaaaaaaaaaaaaaaa 10.65.0.10 10.65.200.5 40000 443 6 3 180 1795000000 1795000060 REJECT OK",
  "2 111122223333 eni-0aaaaaaaaaaaaaaaa 10.65.0.10 93.184.216.34 40001 443 6 2 120 1795000000 1795000060 ACCEPT OK",
  "2 111122223333 eni-0aaaaaaaaaaaaaaaa 10.65.0.10 93.184.216.34 40002 443 6 2 120 1795000060 1795000120 ACCEPT OK",
  "2 111122223333 eni-0aaaaaaaaaaaaaaaa 10.65.0.10 52.216.10.10 40003 443 6 10 1000 1795000000 1795000060 ACCEPT OK",
  "2 111122223333 eni-0bbbbbbbbbbbbbbbb 10.65.208.4 140.82.112.6 40004 443 6 8 800 1795000000 1795000060 ACCEPT OK",
  "2 111122223333 eni-0aaaaaaaaaaaaaaaa - - - - - - - 1795000000 1795000060 - NODATA"
]' >"$tmp/flows.json"
report_file="$tmp/repo/docs/security/FIREWALL_REHEARSAL_$(jq -rn '1795000000 | strftime("%Y-%m-%d")').md"

filled_env
run_json pass
FAKE_PROXY_LOG="$tmp/proxy.json" FAKE_FLOW_LOG="$tmp/flows.json" run report
expect "report writes docs/security/FIREWALL_REHEARSAL_<date of the run>.md" test "$status" = 0 -a -f "$report_file"
report=$(cat "$report_file" 2>/dev/null)
has() { grep -qF -- "$1" <<<"$report"; }
expect "a denied host and a direct connection make it FAIL" has "**Result: FAIL.**"
expect "every host seen at the proxy is listed, with whether the inventory has it" \
  has '| `api.search.brave.com` | 1 | 0 | 1 | **no** |'
expect "a host a leading-dot entry covers counts as listed" has '| `eu12.salesforce.com` | 1 | 1 | 0 | yes |'
expect "squid's own log lines are not counted as requests" has "1 line(s) of the proxy log were not requests"
expect "a REJECT from an app subnet is listed" has "| 10.65.0.10 | 10.65.200.5 | 443 | tcp | 1 |"
expect "a connection out of the VPC from an app subnet is a direct attempt" has "| 10.65.0.10 | 93.184.216.34 | 443 | tcp | ACCEPT | 2 |"
expect "S3 through the gateway endpoint is not" bash -c "! grep -qF '52.216.10.10' <<<\"\$1\"" _ "$report"
expect "the stand-in proxy's own traffic is not" bash -c "! grep -qF '140.82.112.6' <<<\"\$1\"" _ "$report"
expect "the magic link passes: SES was reached through the proxy" has "| 4 | Magic link | pass | the request was accepted and email.us-east-1.amazonaws.com was reached"
expect "a check not run is reported as not run" has "| 3 | Browser | not run |"
expect "the deviations name the unlisted host" has "the inventory does not list for this deployment: \`api.search.brave.com\`"
expect "and the listed hosts nothing exercised" has '`.force.com`'
expect "no account id or interface id reaches the report" bash -c "! grep -Eq '111122223333|eni-' <<<\"\$1\"" _ "$report"
expect "report reads both logs and the addresses it compares against" \
  test -n "$(logged 'standin-proxy' && logged 'vpc-flow-logs' && logged 'get-managed-prefix-list-entries' && echo y)"

jq '[.[] | select(test("email") | not)]' "$tmp/proxy.json" >"$tmp/proxy-no-ses.json"
run_json pass
FAKE_PROXY_LOG="$tmp/proxy-no-ses.json" FAKE_FLOW_LOG="$tmp/flows.json" run report
report=$(cat "$report_file" 2>/dev/null)
expect "without SES at the proxy the magic-link check fails" \
  has "| 4 | Magic link | **fail** | the request was accepted, but the proxy log shows no allowed request"

jq -n '["1795000012.789 300 10.65.0.12 TCP_TUNNEL/200 6100 CONNECT email.us-east-1.amazonaws.com:443 - HIER_DIRECT/1.2.3.4 -"]' >"$tmp/proxy-clean.json"
jq -n '[]' >"$tmp/flows-clean.json"
run_json pass
FAKE_PROXY_LOG="$tmp/proxy-clean.json" FAKE_FLOW_LOG="$tmp/flows-clean.json" run report
report=$(cat "$report_file" 2>/dev/null)
expect "a clean run with checks not run is INCOMPLETE, not PASS" has "**Result: INCOMPLETE.**"

rm -f "$tmp/work/run.json"
run report
expect "report without a run is refused" test "$status" = 1 -a -n "$(says 'run `rehearsal.sh run` first' && echo y)"

echo "down:"

filled_env
run down
expect "down destroys every stack, in reverse apply order" \
  test "$(stack_order ' destroy')" = "60-observability 40-services 50-agentcore 35-deploy-tasks 30-platform 20-data 10-network 00-foundation"
expect "down never applies" not_logged " apply "
expect "down leaves Terraform's confirmation on" not_logged "auto-approve"

echo "allowlist:"

committed_env
run allowlist --check
expect "the committed proxy_allowlist is the inventory's proxy list" test "$status" = 0
expect "the inventory runs with the environment's switches" \
  test -n "$(grep -qx 'ENABLED_CONNECTOR_PROVIDERS=salesforce,github' "$tmp/state/pnpm.env" &&
    grep -qx 'ANALYTICS_PROVIDER=none' "$tmp/state/pnpm.env" &&
    grep -qx 'GITHUB_EVENT_INGEST_MODE=poll' "$tmp/state/pnpm.env" &&
    grep -qx 'WEB_FETCH_ENABLED=0' "$tmp/state/pnpm.env" &&
    grep -qx 'WEB_SEARCH_PROVIDER=none' "$tmp/state/pnpm.env" &&
    grep -qx 'INVITE_EMAIL_PROVIDER=ses' "$tmp/state/pnpm.env" &&
    grep -qx 'AGENTCORE_BROWSER_ENABLED=1' "$tmp/state/pnpm.env" &&
    grep -qx 'AWS_REGION=us-east-1' "$tmp/state/pnpm.env" && echo y)"
expect "it runs from the repository root" logged "pnpm --silent egress:inventory --allowlist"

GITHUB_API_URL=https://api.github.com run allowlist --check
expect "the caller's own environment does not reach the inventory" bash -c "! grep -q '^GITHUB_API_URL=' '$tmp/state/pnpm.env'"

jq '.proxyHosts += ["login.example.org", "*.example.org", "example.org"]' "$here/fixtures/rehearsal/egress-allowlist.json" >"$tmp/more.json"
FAKE_ALLOWLIST="$tmp/more.json" run allowlist --check
expect "--check fails while the block differs, and shows the difference" \
  test "$status" = 1 -a -n "$(says '> .example.org' && echo y)"
FAKE_ALLOWLIST="$tmp/more.json" run allowlist
expect "allowlist rewrites the block" test "$status" = 0
expect "a wildcard becomes squid's leading dot, and the hosts it covers go" test \
  "$(awk '/^# BEGIN proxy_allowlist/{on=1;next} /^# END/{on=0} on' "$env_dir/env.tfvars" | grep -c 'example.org')" = 1
expect "nothing outside the block changes" bash -c \
  "diff <(grep -v 'example.org' '$env_dir/env.tfvars') '$src/envs/personal-rehearsal/env.tfvars' >/dev/null"

jq '.proxyHosts += ["*"]' "$here/fixtures/rehearsal/egress-allowlist.json" >"$tmp/any.json"
committed_env
FAKE_ALLOWLIST="$tmp/any.json" run allowlist
expect "an inventory that needs any host is refused" test "$status" = 1 -a -n "$(says 'WEB_FETCH_ENABLED' && echo y)"
expect "and env.tfvars is left alone" cmp -s "$env_dir/env.tfvars" "$src/envs/personal-rehearsal/env.tfvars"

echo "usage and consistency:"

for args in "" "deploy" "up extra" "--plan-only apply" "allowlist --force" "run --check"; do
  # shellcheck disable=SC2086 # the arguments are split on purpose
  run $args
  expect "usage error: '$args'" test "$status" = 2 -a ! -s "$log"
done

expect "the apply order is affected.sh's" test \
  "$(grep '^apply_order=(' "$here/rehearsal.sh")" = "$(grep '^apply_order=(' "$here/affected.sh")"
expect "every stack has a plan-only fixture" bash -c \
  "for s in $src/stacks/*/; do test -f '$here/fixtures/rehearsal/'\$(basename \$s).tftest.hcl || exit 1; done"

echo
echo "rehearsal.sh: $pass passed, $fail failed"
[ "$fail" = 0 ]
