#!/usr/bin/env bash
# Fixtures for sg-rules.sh: security group rules that exist in AWS but in no
# Terraform state, which no plan can show. A rule opened in the console must
# be found; a rule another stack of the environment manages must not be.
#
# `live` runs against a stand-in `aws`. No credentials, no AWS calls.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
script="$here/sg-rules.sh"
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
expect() { # name expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected:
$2
got:
$3"; fi
}

drift="$here/fixtures/plan-report/drift.json"
mixed="$here/fixtures/plan-report/mixed.json"

echo "managed:"

expect "groups and rule ids of the state, in every module, data sources left out" \
  '{"groups":["sg-0alb","sg-0proxy","sg-0web"],"rules":["sgr-0albhttps","sgr-0albtoweb","sgr-0webfromalb"]}' \
  "$(bash "$script" managed "$drift")"
expect "a plan without state manages nothing" '{"groups":[],"rules":[]}' "$(bash "$script" managed "$mixed")"
if bash "$script" managed "$drift" | grep -qE '10\.0\.0\.0|443|3001|cmp-unit'; then
  bad "no port, range or name leaves the state" "$(bash "$script" managed "$drift")"
else
  ok "no port, range or name leaves the state"
fi

echo "live:"

# aws: logs its arguments; answers with $FAKE_RULES for describe-security-group-rules.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/aws" <<'EOF'
#!/usr/bin/env bash
echo "aws $*" >> "$FAKE_LOG"
[ "$1 $2" = "ec2 describe-security-group-rules" ] || { echo "unexpected aws $*" >&2; exit 99; }
[ -z "${FAKE_AWS_FAIL:-}" ] || { echo "An error occurred (UnauthorizedOperation)" >&2; exit 254; }
cat "$FAKE_RULES"
EOF
chmod +x "$tmp/bin/aws"
cat > "$tmp/rules.json" <<'EOF'
{"SecurityGroupRules": [
  {"SecurityGroupRuleId": "sgr-0webfromalb", "GroupId": "sg-0web", "IsEgress": false, "IpProtocol": "tcp", "FromPort": 3001, "ToPort": 3001},
  {"SecurityGroupRuleId": "sgr-0console", "GroupId": "sg-0web", "IsEgress": false, "IpProtocol": "tcp", "FromPort": 5432, "ToPort": 5432, "CidrIpv4": "0.0.0.0/0"},
  {"SecurityGroupRuleId": "sgr-0albhttps", "GroupId": "sg-0alb", "IsEgress": false, "CidrIpv4": "10.0.0.0/8"},
  {"SecurityGroupRuleId": "sgr-0albtoweb", "GroupId": "sg-0alb", "IsEgress": true},
  {"SecurityGroupRuleId": "sgr-0fromdata", "GroupId": "sg-0proxy", "IsEgress": true}
]}
EOF
bash "$script" managed "$drift" > "$tmp/managed.json"
live() { # managed.json -> sets $status, $output, $log
  log="$tmp/aws.log"
  : > "$log"
  output=$(env PATH="$tmp/bin:$PATH" FAKE_LOG="$log" FAKE_RULES="$tmp/rules.json" bash "$script" live "$1" 2>&1)
  status=$?
}

live "$tmp/managed.json"
expect "every rule of the groups, by id, group and direction only" \
  '[{"id":"sgr-0albhttps","group":"sg-0alb","egress":false},{"id":"sgr-0albtoweb","group":"sg-0alb","egress":true},{"id":"sgr-0fromdata","group":"sg-0proxy","egress":true},{"id":"sgr-0console","group":"sg-0web","egress":false},{"id":"sgr-0webfromalb","group":"sg-0web","egress":false}]' \
  "$output"
expect "one read-only call for the managed groups" \
  "aws ec2 describe-security-group-rules --filters Name=group-id,Values=sg-0alb,sg-0proxy,sg-0web --output json" \
  "$(cat "$log")"
printf '%s\n' "$output" > "$tmp/live.json"

echo '{"groups":[],"rules":[]}' > "$tmp/none.json"
live "$tmp/none.json"
expect "no group, no AWS call, no rule" "0 [] 0" "$status $output $(wc -l < "$log" | tr -d ' ')"

jq -c '{groups: [range(0; 150) | "sg-\(.)"], rules: []}' -n > "$tmp/many.json"
live "$tmp/many.json"
expect "many groups are asked for 100 at a time" 2 "$(wc -l < "$log" | tr -d ' ')"

FAKE_AWS_FAIL=1 live "$tmp/managed.json"
expect "an AWS error fails, it is never an empty answer" 1 "$status"

echo '{"groups":["sg-0alb","--query=x"],"rules":[]}' > "$tmp/bad-group.json"
live "$tmp/bad-group.json"
expect "a group id that is not one is refused before AWS is asked" "1 0" "$status $(wc -l < "$log" | tr -d ' ')"

echo "unmanaged:"

expect "a rule opened in the console is found" \
  '[{"id":"sgr-0fromdata","group":"sg-0proxy","egress":true},{"id":"sgr-0console","group":"sg-0web","egress":false}]' \
  "$(bash "$script" unmanaged "$tmp/live.json" "$tmp/managed.json")"
echo '{"groups":[],"rules":["sgr-0fromdata"]}' > "$tmp/data-stack.json"
expect "a rule another stack of the environment manages is not" \
  '[{"id":"sgr-0console","group":"sg-0web","egress":false}]' \
  "$(bash "$script" unmanaged "$tmp/live.json" "$tmp/managed.json" "$tmp/data-stack.json")"
echo '{"groups":[],"rules":["sgr-0console"]}' > "$tmp/console-adopted.json"
expect "once every rule is managed, nothing is found" '[]' \
  "$(bash "$script" unmanaged "$tmp/live.json" "$tmp/managed.json" "$tmp/data-stack.json" "$tmp/console-adopted.json")"

echo "errors:"

for args in "managed" "managed $drift extra" "live" "unmanaged $tmp/live.json" "verdict $drift" "managed $tmp/missing.json"; do
  # shellcheck disable=SC2086 # the arguments are split on purpose
  out=$(bash "$script" $args 2>&1)
  status=$?
  if [ "$status" = 2 ]; then ok "usage error: $args"; else bad "usage error: $args" "exit $status: $out"; fi
done
out=$(bash "$script" managed "$tmp/live.json" 2>&1)
expect "a file that is not a plan is refused" 1 "$?"
out=$(bash "$script" unmanaged "$tmp/managed.json" "$tmp/managed.json" 2>&1)
expect "a live list that is not one is refused" 1 "$?"
out=$(bash "$script" unmanaged "$tmp/live.json" "$tmp/live.json" 2>&1)
expect "a managed set that is not one is refused" 1 "$?"

echo
echo "sg-rules.sh: $pass passed, $fail failed"
[ "$fail" = 0 ]
