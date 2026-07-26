#!/usr/bin/env bash
# Regression coverage for the production CVE gate's classification. The gate
# must never (a) let a real advisory through, nor (b) announce a CVE when the
# audit merely failed to run — the second is what review caught: an unmatched
# network error was being reported as "Production CVE found".
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
check "real advisory fails closed" 1 "Production CVE found" \
  'echo "1 vulnerabilities found"; echo "Severity: 1 high"; exit 1'
check "advisory table alone fails closed" 1 "Production CVE found" \
  'echo "│ Paths │ apps/web > bad-pkg"; exit 1'
# The review finding: none of these may be reported as a CVE.
check "gzip parse error warns, no CVE claim" 0 "could not run" \
  'echo "ERROR  Unexpected token is not valid JSON"; exit 1'
check "EAI_AGAIN warns, no CVE claim" 0 "could not run" \
  'echo "request to registry.npmjs.org failed: getaddrinfo EAI_AGAIN"; exit 1'
check "ENOTFOUND warns, no CVE claim" 0 "could not run" \
  'echo "ENOTFOUND registry.npmjs.org"; exit 1'
check "TLS failure warns, no CVE claim" 0 "could not run" \
  'echo "unable to verify the first certificate"; exit 1'
check "proxy 407 warns, no CVE claim" 0 "could not run" \
  'echo "407 Proxy Authentication Required"; exit 1'
check "a transient failure that then succeeds passes" 0 "No known high/critical CVEs" \
  'f="$TMPDIR/gate-retry-marker"; if [ -f "$f" ]; then rm -f "$f"; exit 0; else touch "$f"; echo "ECONNRESET"; exit 1; fi'

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
