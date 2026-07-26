#!/usr/bin/env bash
# Regression coverage for the production CVE gate's classifier.
#
# Two directions must both hold, and the fail-CLOSED one matters most:
#   - a real advisory must NEVER be reclassified as an outage (silent pass)
#   - an outage must NEVER be announced as a CVE (fabricated finding)
set -uo pipefail
cd "$(dirname "$0")/.."
pass=0; fail=0
stub_dir="$(mktemp -d)"
trap 'rm -rf "$stub_dir"' EXIT

check() { # name expected_exit expected_substr stub_body
  local name="$1" want_exit="$2" want="$3" body="$4"
  local stub="$stub_dir/stub.sh"
  printf '#!/usr/bin/env bash\n%s\n' "$body" > "$stub"
  chmod +x "$stub"
  local out got
  out="$(AUDIT_CMD="$stub" ATTEMPTS=2 SLEEP_BASE=0 bash scripts/audit-prod-deps.sh 2>&1)"
  got=$?
  if [ "$got" = "$want_exit" ] && printf '%s' "$out" | grep -qF "$want"; then
    echo "  ok   $name"; pass=$((pass+1))
  else
    echo "  FAIL $name (exit=$got want=$want_exit)"; printf '%s\n' "$out" | sed 's/^/       /'; fail=$((fail+1))
  fi
}

echo "audit gate classification:"

check "clean audit passes" 0 "No known high/critical CVEs" \
  'exit 0'

# --- fail-closed direction: a real advisory must block ---
check "advisories object blocks" 1 "Production CVE found" \
  'echo "{\"advisories\":{\"1234\":{\"severity\":\"high\"}},\"metadata\":{\"vulnerabilities\":{\"high\":1}}}"; exit 1'
check "metadata counts alone block" 1 "Production CVE found" \
  'echo "{\"advisories\":{},\"metadata\":{\"vulnerabilities\":{\"critical\":2}}}"; exit 1'
check "node deprecation noise does not hide a finding" 1 "Production CVE found" \
  'echo "(node:123) [DEP0169] DeprecationWarning: url.parse()"; echo "{\"advisories\":{\"9\":{}},\"metadata\":{\"vulnerabilities\":{\"high\":1}}}"; exit 1'

# --- outage direction: must never claim a CVE (the earlier review finding) ---
check "pnpm error envelope warns, no CVE claim" 0 "could not run" \
  'echo "{\"error\":{\"code\":\"pnpm\",\"message\":\"Unexpected token is not valid JSON\"}}"; exit 1'
check "unparseable body warns, no CVE claim" 0 "could not run" \
  'echo "<html>502 Bad Gateway</html>"; exit 1'
check "EAI_AGAIN warns, no CVE claim" 0 "could not run" \
  'echo "getaddrinfo EAI_AGAIN registry.npmjs.org"; exit 1'
check "TLS failure warns, no CVE claim" 0 "could not run" \
  'echo "unable to verify the first certificate"; exit 1'
check "empty output warns, no CVE claim" 0 "could not run" \
  'exit 1'

# --- non-zero exit with a structurally clean report is not a finding ---
check "zero-count report passes" 0 "No known high/critical CVEs" \
  'echo "{\"advisories\":{},\"metadata\":{\"vulnerabilities\":{\"high\":0,\"critical\":0}}}"; exit 1'

# The stub runs as a separate process, so it cannot see this script's locals.
# GATE_TEST_MARKER is exported below specifically so the retry case can keep
# state across the two invocations.
export GATE_TEST_MARKER="$stub_dir/retry-marker"
rm -f "$GATE_TEST_MARKER"
check "a transient failure that then succeeds passes" 0 "No known high/critical CVEs" \
  'if [ -f "$GATE_TEST_MARKER" ]; then exit 0; else touch "$GATE_TEST_MARKER"; echo "ECONNRESET"; exit 1; fi'

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
