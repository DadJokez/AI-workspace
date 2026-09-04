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
  out="$(AUDIT_CMD="$stub" ATTEMPTS=2 SLEEP_BASE=0 AUDIT_ATTEMPT_TIMEOUT="${GATE_TEST_TIMEOUT:-150}" bash scripts/audit-prod-deps.sh 2>&1)"
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

# The review finding: stderr noise beside a real report must not break parsing
# and downgrade a finding to "outage" (that would fail OPEN on a live CVE).
check "stderr noise cannot hide a finding" 1 "Production CVE found" \
  'echo "WARN  Ignoring unknown option" >&2; echo "{\"advisories\":{\"7\":{}},\"metadata\":{\"vulnerabilities\":{\"high\":1}}}"; exit 1'
check "update-notifier chatter cannot hide a finding" 1 "Production CVE found" \
  'echo "Update available 9.12.3 -> 10.0.0" >&2; echo "{\"metadata\":{\"vulnerabilities\":{\"critical\":1}}}"; exit 1'

# Severity contract: counts are authoritative when present.
check "sub-high advisories with zero high/critical do not block" 0 "No known high/critical CVEs" \
  'echo "{\"advisories\":{\"3\":{\"severity\":\"moderate\"}},\"metadata\":{\"vulnerabilities\":{\"moderate\":1,\"high\":0,\"critical\":0}}}"; exit 1'
check "advisories with no severity breakdown still block" 1 "Production CVE found" \
  'echo "{\"advisories\":{\"3\":{\"severity\":\"high\"}}}"; exit 1'

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

# --- per-attempt bound (#875): a hung registry is an outage, not a job cap ---
# `sleep 5` past a 1s bound stands in for a hung advisory endpoint. These
# cases need a timeout helper; without one the bound cannot be exercised.
if command -v timeout >/dev/null 2>&1 || command -v gtimeout >/dev/null 2>&1; then
  export GATE_TEST_TIMEOUT=1
  check "a hung attempt is retried then warns, no CVE claim" 0 "could not run" \
    'sleep 5; exit 0'
  rm -f "$GATE_TEST_MARKER"
  check "a hang then a clean run passes" 0 "No known high/critical CVEs" \
    'if [ -f "$GATE_TEST_MARKER" ]; then exit 0; else touch "$GATE_TEST_MARKER"; sleep 5; exit 0; fi'
  rm -f "$GATE_TEST_MARKER"
  check "a hang then a HIGH finding still fails closed" 1 "Production CVE found" \
    'if [ -f "$GATE_TEST_MARKER" ]; then echo "{\"advisories\":{\"1\":{}},\"metadata\":{\"vulnerabilities\":{\"high\":1}}}"; exit 1; else touch "$GATE_TEST_MARKER"; sleep 5; exit 0; fi'
  unset GATE_TEST_TIMEOUT
else
  echo "  skip hang cases: no timeout/gtimeout on PATH"
fi

# No timeout helper on PATH (macOS without coreutils): still runs, says so.
# A PATH holding only the tools the gate needs, minus timeout/gtimeout.
no_helper_bin="$stub_dir/bin"
mkdir -p "$no_helper_bin"
for tool in bash node seq sleep cat mktemp rm; do
  ln -sf "$(command -v "$tool")" "$no_helper_bin/$tool"
done
printf '#!/usr/bin/env bash\nexit 0\n' > "$stub_dir/clean.sh"; chmod +x "$stub_dir/clean.sh"
out="$(PATH="$no_helper_bin" AUDIT_CMD="$stub_dir/clean.sh" ATTEMPTS=2 SLEEP_BASE=0 bash scripts/audit-prod-deps.sh 2>&1)"
got=$?
if [ "$got" = 0 ] && printf '%s' "$out" | grep -qF "no timeout/gtimeout helper found" \
   && printf '%s' "$out" | grep -qF "No known high/critical CVEs"; then
  echo "  ok   missing timeout helper runs unbounded with a notice"; pass=$((pass+1))
else
  echo "  FAIL missing timeout helper runs unbounded with a notice (exit=$got)"; printf '%s\n' "$out" | sed 's/^/       /'; fail=$((fail+1))
fi

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
