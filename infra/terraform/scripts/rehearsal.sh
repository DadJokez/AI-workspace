#!/usr/bin/env bash
# rehearsal.sh — the firewall rehearsal (migration spec, WP-19) in
# envs/personal-rehearsal: the application behind the firewall profile, its
# checks run from inside the VPC, and a report of everything that left it.
#
#   rehearsal.sh up        Applies every stack in the apply order with
#                          stack.sh. Stops after 20-data until a human has
#                          written the two secrets and the database roles
#                          (README, "After the first apply of 20-data"); run it
#                          again then. Writes the internal load balancer's URL
#                          into env.tfvars before 35-deploy-tasks and runs the
#                          migrator after it.
#   rehearsal.sh run       Runs the checks, each an ECS task from the worker
#                          image in the app subnets (run-task.sh), and records
#                          the run window and the results.
#   rehearsal.sh report    Reads the stand-in proxy's log and the VPC flow logs
#                          of that window and writes
#                          docs/security/FIREWALL_REHEARSAL_<date>.md.
#   rehearsal.sh down      Destroys every stack, in reverse apply order. The
#                          state bucket (bootstrap/) is not a stack and stays.
#
#   rehearsal.sh --plan-only [up] [run] [report] [down]
#                          The dry run, without AWS credentials (all four when
#                          none is named). `up` plans every stack with
#                          `terraform test` against a mocked AWS provider and
#                          checks each plan with the Conftest rules; the others
#                          print the commands they would run. A real
#                          `terraform plan` of a new environment is not
#                          possible: each stack reads what the stacks before it
#                          publish to SSM, which does not exist until they are
#                          applied.
#
#   rehearsal.sh allowlist [--check]
#                          Regenerates proxy_allowlist in env.tfvars from the
#                          egress inventory (`pnpm egress:inventory
#                          --allowlist`) for this environment's switches;
#                          --check fails while the two differ.
#
# Environment: AWS_REGION (default: aws_region of env.tfvars), REHEARSAL_EMAIL
# (run: the address the magic-link check requests a sign-in link for),
# REHEARSAL_DIR (working files, default infra/terraform/.rehearsal),
# REHEARSAL_REPORT_DIR (default docs/security).
#
# Only `up`, `run` and `down` change AWS, and only a human runs them, with
# administrator credentials for the personal account.
#
# exit: 0 done; 1 a check, plan, rule or command failed; 2 usage error;
#       3 up stopped for the human step after 20-data.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/.." && pwd)
repo=$(cd "$root/../.." && pwd)

env_name=personal-rehearsal
env_dir="$root/envs/$env_name"
fixtures="$here/fixtures/rehearsal"
work_dir=${REHEARSAL_DIR:-$root/.rehearsal}
report_dir=${REHEARSAL_REPORT_DIR:-$repo/docs/security}

# The apply order of affected.sh (rehearsal.test.sh checks they agree).
apply_order=(00-foundation 10-network 20-data 30-platform 35-deploy-tasks 50-agentcore 40-services 60-observability)

usage() {
  cat >&2 <<'EOF'
usage: rehearsal.sh <up|run|report|down>
       rehearsal.sh --plan-only [up] [run] [report] [down]
       rehearsal.sh allowlist [--check]
EOF
  exit 2
}

fail() {
  echo "rehearsal.sh: $*" >&2
  exit 1
}

need() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null || fail "$tool is not on PATH"
  done
}

# --- env.tfvars ----------------------------------------------------------------

# The value of a one-line top-level assignment `<name> = <value>`, without
# quotes or a trailing comment. Fails when the file has no such line.
tfvar() { # name [file]
  awk -v name="$1" '
    $0 ~ "^" name "[[:space:]]*=" {
      sub("^[^=]*=[[:space:]]*", "")
      sub("[[:space:]]+#.*$", "")
      gsub(/^"|"$/, "")
      print
      found = 1
      exit
    }
    END { if (!found) exit 1 }
  ' "${2:-$env_dir/env.tfvars}"
}

# Top-level variables whose value still carries the REPLACE_ME marker.
placeholder_vars() { # file
  awk '
    /^[[:space:]]*#/ { next }
    /^[a-z_][a-z0-9_]*[[:space:]]*=/ { name = $1 }
    /REPLACE_ME/ && name != "" { print name }
  ' "$1" | LC_ALL=C sort -u
}

assigned_vars() { # file
  awk '/^[a-z_][a-z0-9_]*[[:space:]]*=/ { print $1 }' "$1" | LC_ALL=C sort -u
}

# `"KEY" = "value"` lines of a top-level map, as KEY<tab>value.
tfvar_map() { # name [file]
  awk -v name="$1" '
    $0 ~ "^" name "[[:space:]]*=[[:space:]]*\\{" { on = 1; next }
    on && /^\}/ { exit }
    on && /^[[:space:]]*"?[A-Za-z0-9_-]+"?[[:space:]]*=/ {
      line = $0
      sub(/^[[:space:]]*"?/, "", line)
      key = line; sub(/"?[[:space:]]*=.*$/, "", key)
      value = line; sub(/^[^=]*=[[:space:]]*"/, "", value); sub(/"[[:space:]]*(#.*)?$/, "", value)
      print key "\t" value
    }
  ' "${2:-$env_dir/env.tfvars}"
}

# The hosts of the proxy_allowlist block, one per line.
allowlist_hosts() {
  awk '/^# BEGIN proxy_allowlist/ { on = 1; next } /^# END proxy_allowlist/ { on = 0 } on' "$env_dir/env.tfvars" |
    sed -n 's/^[[:space:]]*"\([^"]*\)",*$/\1/p'
}

release_id() {
  tfvar release_id "$env_dir/release.auto.tfvars" 2>/dev/null || true
}

region() {
  echo "${AWS_REGION:-$(tfvar aws_region)}"
}

# --- AWS reads -----------------------------------------------------------------

ssm() { # <stack>/<key>
  aws ssm get-parameter --region "$(region)" --name "/comparative/$env_name/$1" \
    --query Parameter.Value --output text
}

# The task role of the chat-worker service: what the checks that call Bedrock
# run as, in place of the smoke task's role, which has no AWS permission.
worker_task_role() {
  local cluster service task_definition
  cluster=$(ssm 30-platform/cluster_arn)
  service=$(ssm 40-services/service/chat_worker_name)
  task_definition=$(aws ecs describe-services --region "$(region)" --cluster "$cluster" --services "$service" \
    --query 'services[0].taskDefinition' --output text)
  aws ecs describe-task-definition --region "$(region)" --task-definition "$task_definition" \
    --query 'taskDefinition.taskRoleArn' --output text
}

# --- the checks ------------------------------------------------------------------

# id, then what it proves; run in this order. The magic-link check goes
# first: on a new, empty database any address may ask for a link, and a smoke
# that fails leaves its user behind, after which REHEARSAL_EMAIL would need an
# invitation.
checks=(
  "magic-link|Magic-link request; the SES call leaves through the proxy"
  "smoke|Authenticated smoke against the internal URL"
  "eval-gate|pnpm eval --gate with real Bedrock through the VPC endpoint"
  "agentcore-mcp|Durable AgentCore run with one MCP facade tool call"
  "scheduled-run|One scheduled run"
  "event-trigger|One GitHub event trigger in poll mode"
  "studio-browser|Studio Browser session start and stop"
)

# Checks that need an in-VPC entry point the application does not have yet.
not_automated_reason="no entry point runs this check inside the VPC yet; it is not run and does not pass"
not_automated=(agentcore-mcp scheduled-run event-trigger studio-browser)

is_not_automated() {
  [[ " ${not_automated[*]} " == *" $1 "* ]]
}

# The magic-link check: ask the web service, over the internal URL, to send a
# sign-in link. The web service sends it through SES, which has no VPC
# endpoint, so the request must leave through the proxy; report checks that it
# did. The address must be allowed to sign in (an existing user, an
# invitation, or an empty users table) and, in the SES sandbox, verified.
read -r -d '' magic_link_js <<'JS' || true
const base = (process.env.SMOKE_BASE_URL ?? "").replace(/\/+$/, "");
const email = process.env.REHEARSAL_EMAIL ?? "";
if (!base || !email) throw new Error("SMOKE_BASE_URL and REHEARSAL_EMAIL are required");
const csrf = await fetch(`${base}/api/auth/csrf`);
if (!csrf.ok) throw new Error(`GET /api/auth/csrf answered ${csrf.status}`);
const { csrfToken } = await csrf.json();
const cookie = csrf.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const response = await fetch(`${base}/api/auth/signin/email`, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", cookie },
  body: new URLSearchParams({ csrfToken, email, callbackUrl: base, json: "true" }),
});
const text = await response.text();
let url = "";
try { url = JSON.parse(text).url ?? ""; } catch {}
console.log(`magic-link request answered ${response.status}: ${url || text.slice(0, 200)}`);
if (response.status !== 200 || !url || url.includes("error=")) process.exit(1);
JS

# TASK_OVERRIDES of each automated check, on the smoke task definition of
# 35-deploy-tasks (worker image, deploy_task security group, app subnets).
check_overrides() { # id worker-task-role
  local id=$1 role=$2
  case "$id" in
    smoke) echo "" ;;
    eval-gate)
      jq -cn --arg role "$role" --arg region "$(region)" --arg prefix "$(tfvar bedrock_inference_profile_prefix)" '{
        taskRoleArn: $role,
        containerOverrides: [{
          name: "smoke",
          command: ["pnpm", "eval", "--gate"],
          environment: [
            {name: "AWS_REGION", value: $region},
            {name: "BEDROCK_CLIENT", value: "real"},
            {name: "BEDROCK_INFERENCE_PROFILE_PREFIX", value: $prefix}
          ]
        }]
      }'
      ;;
    magic-link)
      jq -cn --arg js "$magic_link_js" --arg email "${REHEARSAL_EMAIL:-<REHEARSAL_EMAIL>}" '{
        containerOverrides: [{
          name: "smoke",
          command: ["node", "--input-type=module", "-e", $js],
          environment: [{name: "REHEARSAL_EMAIL", value: $email}]
        }]
      }'
      ;;
  esac
}

# --- up ------------------------------------------------------------------------

secret_has_value() { # name
  aws secretsmanager describe-secret --region "$(region)" --secret-id "comparative/$env_name/$1" --output json |
    jq -e '(.VersionIdsToStages // {}) | length > 0' >/dev/null
}

set_internal_base_url() { # url
  local file="$env_dir/env.tfvars" tmp
  grep -q '^internal_base_url[[:space:]]*=' "$file" || fail "env.tfvars has no internal_base_url line to fill"
  tmp=$(mktemp)
  awk -v url="$1" '/^internal_base_url[[:space:]]*=/ { print "internal_base_url = \"" url "\""; next } { print }' "$file" >"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

apply_stack() { # stack
  echo "== up $env_name/$1"
  "$here/stack.sh" apply "$env_name" "$1" "$work_dir/up/$1"
}

cmd_up() {
  need aws terraform conftest jq
  local rid stack url
  rid=$(release_id)
  [ -n "$rid" ] || fail "envs/$env_name/release.auto.tfvars sets no release_id; copy the release file of the environment being rehearsed (see that file)"

  for stack in 00-foundation 10-network 20-data; do apply_stack "$stack"; done

  if ! secret_has_value app || ! secret_has_value browser-proxy-db; then
    cat >&2 <<EOF
rehearsal.sh: comparative/$env_name/app or comparative/$env_name/browser-proxy-db has no value yet.
  Do the steps of infra/terraform/README.md, "After the first apply of 20-data",
  with ENV_NAME=$env_name, then run \`rehearsal.sh up\` again. In the app secret,
  WEB_SEARCH_PROVIDER is "none" and every other field is present (empty is a value).
EOF
    exit 3
  fi

  apply_stack 30-platform
  url="https://$(ssm 30-platform/alb_dns_name)"
  set_internal_base_url "$url"
  echo "internal_base_url = $url (written to envs/$env_name/env.tfvars)"

  apply_stack 35-deploy-tasks
  echo "== up $env_name: migrator"
  AWS_REGION=$(region) RELEASE_ID=$rid "$here/run-task.sh" "$env_name" migrator

  for stack in 50-agentcore 40-services 60-observability; do apply_stack "$stack"; done
  echo "rehearsal.sh: $env_name is up; next: rehearsal.sh run"
}

# --- run -----------------------------------------------------------------------

cmd_run() {
  need aws jq
  local rid role entry id name log status receipt detail started finished results
  rid=$(release_id)
  [ -n "$rid" ] || fail "envs/$env_name/release.auto.tfvars sets no release_id"
  [ -n "${REHEARSAL_EMAIL:-}" ] || fail "set REHEARSAL_EMAIL to the address the magic-link check requests a link for"

  mkdir -p "$work_dir/run"
  results="$work_dir/run/results.jsonl"
  : >"$results"
  role=$(worker_task_role)
  started=$(date -u +%s)

  for entry in "${checks[@]}"; do
    id=${entry%%|*}
    name=${entry#*|}
    if is_not_automated "$id"; then
      echo "== check $id: not run ($not_automated_reason)"
      jq -cn --arg id "$id" --arg name "$name" --arg detail "$not_automated_reason" \
        '{id: $id, name: $name, status: "not_run", detail: $detail, receipt: null}' >>"$results"
      continue
    fi
    echo "== check $id: $name"
    log="$work_dir/run/$id.log"
    status=0
    TASK_OVERRIDES=$(check_overrides "$id" "$role") AWS_REGION=$(region) RELEASE_ID=$rid \
      "$here/run-task.sh" "$env_name" smoke 2>&1 | tee "$log" || status=$?
    receipt=$(sed -n 's/^Deploy task receipt: //p' "$log" | tail -n 1)
    [ -n "$receipt" ] || receipt=null
    if [ "$status" = 0 ]; then
      detail="task exited 0"
    else
      detail=$(grep '^run-task.sh: ' "$log" | tail -n 1 | sed 's/^run-task.sh: //')
      detail=${detail:-run-task.sh exited $status}
    fi
    jq -cn --arg id "$id" --arg name "$name" --arg status "$([ "$status" = 0 ] && echo pass || echo fail)" \
      --arg detail "$detail" --argjson receipt "$receipt" \
      '{id: $id, name: $name, status: $status, detail: $detail, receipt: $receipt}' >>"$results"
  done

  finished=$(date -u +%s)
  jq -s --arg env "$env_name" --arg release "$rid" --argjson started "$started" --argjson finished "$finished" \
    '{env: $env, release_id: $release, started_at: $started, finished_at: $finished, checks: .}' \
    "$results" >"$work_dir/run.json"
  echo "rehearsal.sh: results in $work_dir/run.json; next: rehearsal.sh report"
  jq -r '.checks[] | "  \(.status)\t\(.id)"' "$work_dir/run.json"
  ! jq -e 'any(.checks[]; .status == "fail")' "$work_dir/run.json" >/dev/null
}

# --- report --------------------------------------------------------------------

# Flow logs are delivered in aggregation windows of up to ten minutes, so the
# report reads that much on either side of the run.
flow_slack=600

cmd_report() {
  need aws jq
  local run_json="$work_dir/run.json" started finished from to vpc_id subnets vpc_cidr app_cidrs prefix_list
  local s3_cidrs date file now
  [ -f "$run_json" ] || fail "no $run_json; run \`rehearsal.sh run\` first"
  started=$(jq -r .started_at "$run_json")
  finished=$(jq -r .finished_at "$run_json")
  from=$(((started - flow_slack) * 1000))
  to=$(((finished + flow_slack) * 1000))
  now=$(date -u +%s)
  if [ "$now" -lt $((finished + flow_slack)) ]; then
    echo "rehearsal.sh: flow logs of the last $((flow_slack / 60)) minutes of the run may not have arrived yet; run report again after $(jq -rn --argjson t $((finished + flow_slack)) '$t | todate')" >&2
  fi

  data=$(mktemp -d)
  trap 'rm -rf "${data:-}"' EXIT

  vpc_id=$(ssm 10-network/vpc_id)
  subnets=$(ssm 10-network/app_subnet_ids)
  vpc_cidr=$(aws ec2 describe-vpcs --region "$(region)" --vpc-ids "$vpc_id" --query 'Vpcs[0].CidrBlock' --output text)
  # shellcheck disable=SC2046 # one argument per subnet id
  app_cidrs=$(aws ec2 describe-subnets --region "$(region)" --subnet-ids $(jq -r '.[]' <<<"$subnets") \
    --query 'Subnets[].CidrBlock' --output json)
  prefix_list=$(aws ec2 describe-managed-prefix-lists --region "$(region)" \
    --filters "Name=prefix-list-name,Values=com.amazonaws.$(region).s3" --query 'PrefixLists[0].PrefixListId' --output text)
  s3_cidrs=$(aws ec2 get-managed-prefix-list-entries --region "$(region)" --prefix-list-id "$prefix_list" \
    --query 'Entries[].Cidr' --output json)

  aws logs filter-log-events --region "$(region)" --log-group-name "/comparative/$env_name/standin-proxy" \
    --start-time "$((started * 1000))" --end-time "$(((finished + 60) * 1000))" \
    --query 'events[].message' --output json >"$data/proxy.json"
  aws logs filter-log-events --region "$(region)" --log-group-name "/comparative/$env_name/vpc-flow-logs" \
    --start-time "$from" --end-time "$to" --query 'events[].message' --output json >"$data/flows.json"
  allowlist_hosts | jq -R . | jq -s . >"$data/allowlist.json"

  jq -n \
    --slurpfile run "$run_json" --slurpfile proxy "$data/proxy.json" --slurpfile flows "$data/flows.json" \
    --slurpfile allowlist "$data/allowlist.json" --argjson app_cidrs "$app_cidrs" --argjson s3_cidrs "$s3_cidrs" \
    --arg vpc_cidr "$vpc_cidr" --arg ses_host "email.$(region).amazonaws.com" \
    -f "$here/rehearsal-report.jq" >"$data/summary.json"

  date=$(jq -rn --argjson t "$started" '$t | strftime("%Y-%m-%d")')
  mkdir -p "$report_dir"
  file="$report_dir/FIREWALL_REHEARSAL_$date.md"
  jq -r --arg date "$date" -f "$here/rehearsal-markdown.jq" "$data/summary.json" >"$file"
  echo "rehearsal.sh: wrote $file"
  jq -r '"result: \(.verdict)"' "$data/summary.json"
}

# --- down ----------------------------------------------------------------------

cmd_down() {
  need terraform
  local index
  [ -n "$(release_id)" ] || fail "envs/$env_name/release.auto.tfvars sets no release_id; destroy needs the same variables as apply"
  for ((index = ${#apply_order[@]} - 1; index >= 0; index--)); do
    echo "== down $env_name/${apply_order[index]}"
    # Terraform asks for confirmation of each stack's destroy.
    "$root/tf.sh" "$env_name" "${apply_order[index]}" destroy
  done
  echo "rehearsal.sh: $env_name is destroyed; the state bucket stays"
}

# --- --plan-only -----------------------------------------------------------------

plan_only_up() {
  need terraform conftest jq
  local missing tags stack dir out status=0
  missing=$(LC_ALL=C comm -23 \
    <(cat <(placeholder_vars "$env_dir/env.tfvars") <(placeholder_vars "$env_dir/release.auto.tfvars") | LC_ALL=C sort -u) \
    <(assigned_vars "$fixtures/plan-only.tfvars"))
  [ -z "$missing" ] || fail "fixtures/rehearsal/plan-only.tfvars has no stand-in for: $(paste -sd ' ' <<<"$missing")"

  # The mocked provider does not merge default_tags into tags_all; the real
  # one does. The plan handed to Conftest gets the merge the provider would do.
  tags=$(tfvar_map tags "$fixtures/plan-only.tfvars" | jq -R -s 'split("\n") | map(select(. != "") | split("\t") | {(.[0]): .[1]}) | add // {}')

  # Global, so that the EXIT trap still sees it after the function returns.
  work=$(mktemp -d)
  trap 'rm -rf "${work:-}"' EXIT
  export TF_PLUGIN_CACHE_DIR=${TF_PLUGIN_CACHE_DIR:-$work/plugin-cache}
  mkdir -p "$TF_PLUGIN_CACHE_DIR"
  # A copy of the stacks and modules: the test directory must sit inside the
  # stack directory, and the source tree stays untouched.
  cp -R "$root/modules" "$work/modules"
  out="$work_dir/plan-only"
  rm -rf "$out"

  for stack in "${apply_order[@]}"; do
    echo "== plan-only $env_name/$stack (mocked AWS provider)"
    [ -f "$fixtures/$stack.tftest.hcl" ] || fail "no fixtures/rehearsal/$stack.tftest.hcl"
    dir="$work/stacks/$stack"
    mkdir -p "$dir/rehearsal" "$out/$stack"
    cp "$root/stacks/$stack"/*.tf "$root/stacks/$stack/.terraform.lock.hcl" "$dir/"
    cp "$fixtures/$stack.tftest.hcl" "$dir/rehearsal/rehearsal.tftest.hcl"

    terraform -chdir="$dir" init -backend=false -input=false >/dev/null
    if ! terraform -chdir="$dir" test -test-directory=rehearsal -json -verbose \
      -var-file="$env_dir/env.tfvars" -var-file="$fixtures/plan-only.tfvars" >"$out/$stack/test.jsonl"; then
      jq -r 'select(.type == "diagnostic") | "  \(.diagnostic.severity): \(.diagnostic.summary): \(.diagnostic.detail // "")"' \
        "$out/$stack/test.jsonl" >&2 || true
      fail "$stack does not plan with envs/$env_name"
    fi
    jq -c --argjson tags "$tags" 'select(.type == "test_plan") | .test_plan | {format_version: .plan_format_version, resource_changes: [
      .resource_changes[]
      | if ((.change.after | type) == "object") and (.change.after | has("tags_all")) and (.change.after_unknown.tags_all != true)
        then .change.after.tags_all = ($tags + (.change.after.tags // {})) else . end
    ]}' "$out/$stack/test.jsonl" >"$out/$stack/plan.json"
    [ "$(jq -s length "$out/$stack/plan.json")" = 1 ] || fail "$stack: expected exactly one plan from the mocked run"

    if ! conftest test --policy "$root/policy" --no-color "$out/$stack/plan.json"; then
      echo "rehearsal.sh: a Conftest rule rejects the plan of $stack" >&2
      status=1
    fi
    "$here/plan-report.sh" summary "$out/$stack/plan.json"
  done
  [ "$status" = 0 ] || fail "a Conftest rule rejects the rehearsal's plans (above)"
  echo "plan-only up: every stack plans against the mocked provider and passes the rules; plans in $out"
}

plan_only_run() {
  local rid entry id name overrides
  rid=$(release_id)
  echo "== plan-only run: the checks, each an ECS task (run-task.sh reads the cluster, the app subnets, the"
  echo "   deploy_task security group and the smoke task definition from /comparative/$env_name/ in SSM)"
  echo "   worker task role: aws ecs describe-services, then describe-task-definition, of /comparative/$env_name/40-services/service/chat_worker_name"
  for entry in "${checks[@]}"; do
    id=${entry%%|*}
    name=${entry#*|}
    if is_not_automated "$id"; then
      echo "[$id] $name: not run: $not_automated_reason"
      continue
    fi
    overrides=$(check_overrides "$id" "<task role of the chat-worker service>")
    # The overrides hold no single quote, so they print as one quoted word.
    [[ "$overrides" != *"'"* ]] || fail "the overrides of $id contain a single quote"
    printf "[%s] %s:\n  TASK_OVERRIDES='%s' AWS_REGION=%s RELEASE_ID=%s infra/terraform/scripts/run-task.sh %s smoke\n" \
      "$id" "$name" "$overrides" "$(region)" "${rid:-<release_id of release.auto.tfvars>}" "$env_name"
  done
}

plan_only_report() {
  echo "== plan-only report: reads, for the run window in $work_dir/run.json (flow logs $((flow_slack / 60)) minutes either side)"
  echo "  aws logs filter-log-events --log-group-name /comparative/$env_name/standin-proxy"
  echo "  aws logs filter-log-events --log-group-name /comparative/$env_name/vpc-flow-logs"
  echo "  aws ec2 describe-vpcs / describe-subnets (/comparative/$env_name/10-network/vpc_id, app_subnet_ids)"
  echo "  aws ec2 get-managed-prefix-list-entries (com.amazonaws.$(region).s3: the gateway endpoint's addresses)"
  echo "  and writes ${report_dir#"$repo"/}/FIREWALL_REHEARSAL_<date>.md"
}

plan_only_down() {
  local index
  echo "== plan-only down: in reverse apply order"
  for ((index = ${#apply_order[@]} - 1; index >= 0; index--)); do
    echo "  infra/terraform/tf.sh $env_name ${apply_order[index]} destroy"
  done
}

# --- allowlist -------------------------------------------------------------------

# The proxy hosts of the egress inventory for this environment, in squid's
# dstdomain form: `*.example.com` becomes `.example.com`, and a host such a
# domain covers is dropped (squid warns about it and ignores it).
generate_allowlist() {
  need pnpm jq
  local pairs=() key value
  while IFS=$'\t' read -r key value; do
    pairs+=("$key=$value")
  done < <(tfvar_map extra_environment)

  # Only what this environment's services receive: the caller's own
  # environment (a GITHUB_API_URL of GitHub Actions, for one) must not leak in.
  # AGENTCORE_RUNTIME_ARN and INTERNAL_BASE_URL count only by being set.
  (cd "$repo" && env -i PATH="$PATH" HOME="${HOME:-/tmp}" \
    AWS_REGION="$(tfvar aws_region)" \
    INVITE_EMAIL_PROVIDER="$(tfvar invite_email_provider)" \
    WEB_SEARCH_PROVIDER="$(tfvar agentcore_web_search_provider)" \
    AGENTCORE_BROWSER_ENABLED="$([ "$(tfvar agentcore_browser_enabled)" = true ] && echo 1 || echo 0)" \
    AGENTCORE_RUNTIME_ARN="arn:aws:bedrock-agentcore:$(tfvar aws_region):111122223333:runtime/stand-in" \
    INTERNAL_BASE_URL="https://internal.invalid" \
    NEXTAUTH_URL="https://rehearsal.invalid" \
    "${pairs[@]}" \
    pnpm --silent egress:inventory --allowlist) |
    jq -r '
      [.proxyHosts[] | if startswith("*.") then .[1:] else . end] as $hosts
      | [$hosts[] | select(startswith(".")) ] as $domains
      | $hosts[]
      | . as $host
      | select(any($domains[]; . as $domain | $domain != $host and (($host | endswith($domain)) or $host == $domain[1:])) | not)
    ' | LC_ALL=C sort -u
}

allowlist_block() { # hosts on stdin
  echo "proxy_allowlist = ["
  sed 's/.*/  "&",/'
  echo "]"
}

cmd_allowlist() {
  local check=${1:-} generated current tmp
  generated=$(generate_allowlist)
  [ -n "$generated" ] || fail "the egress inventory produced no proxy hosts"
  if grep -qx '\*' <<<"$generated"; then
    fail "the inventory needs any host (*) through the proxy, which an allowlist cannot express; is WEB_FETCH_ENABLED \"0\" in extra_environment?"
  fi
  current=$(allowlist_hosts)
  if [ "$check" = --check ]; then
    if [ "$generated" != "$current" ]; then
      echo "rehearsal.sh: proxy_allowlist in envs/$env_name/env.tfvars differs from the egress inventory:" >&2
      diff <(echo "$current") <(echo "$generated") >&2 || true
      echo "run infra/terraform/scripts/rehearsal.sh allowlist to regenerate it" >&2
      exit 1
    fi
    echo "proxy_allowlist matches the egress inventory ($(wc -l <<<"$generated" | tr -d ' ') hosts)"
    return
  fi
  grep -q '^# BEGIN proxy_allowlist' "$env_dir/env.tfvars" && grep -q '^# END proxy_allowlist' "$env_dir/env.tfvars" ||
    fail "env.tfvars has no # BEGIN / # END proxy_allowlist markers"
  tmp=$(mktemp)
  awk -v block="$(allowlist_block <<<"$generated")" '
    /^# BEGIN proxy_allowlist/ { print; print block; skip = 1; next }
    /^# END proxy_allowlist/ { skip = 0 }
    !skip
  ' "$env_dir/env.tfvars" >"$tmp"
  cat "$tmp" >"$env_dir/env.tfvars"
  rm -f "$tmp"
  echo "proxy_allowlist regenerated ($(wc -l <<<"$generated" | tr -d ' ') hosts)"
}

# --- main ------------------------------------------------------------------------

[ "$#" -ge 1 ] || usage
case "$1" in
  --plan-only)
    shift
    [ "$#" -gt 0 ] || set -- up run report down
    for step in "$@"; do
      case "$step" in up | run | report | down) ;; *) usage ;; esac
    done
    for step in "$@"; do "plan_only_$step"; done
    ;;
  up | run | report | down)
    [ "$#" -eq 1 ] || usage
    "cmd_$1"
    ;;
  allowlist)
    [ "$#" -eq 1 ] || { [ "$#" -eq 2 ] && [ "$2" = --check ]; } || usage
    cmd_allowlist "${2:-}"
    ;;
  *) usage ;;
esac
