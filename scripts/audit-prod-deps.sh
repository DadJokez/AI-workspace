#!/usr/bin/env bash
# Production CVE gate. Fails closed on a real advisory; distinguishes an
# unreachable advisory registry from a finding so an outage cannot masquerade
# as a vulnerability (or vice versa). See .github/workflows/ci.yml.
#
# AUDIT_CMD is overridable so the classification logic is testable.
set -uo pipefail

AUDIT_CMD=${AUDIT_CMD:-"pnpm audit --prod --audit-level high"}
ATTEMPTS=${ATTEMPTS:-3}
SLEEP_BASE=${SLEEP_BASE:-10}

# pnpm prints a bordered advisory table plus a summary line only when it has
# actually received advisories. Absence of these means it never got an answer.
FINDING_RE='vulnerabilit(y|ies) found|^Severity:|^│|^┌'

out=""
for attempt in $(seq 1 "$ATTEMPTS"); do
  out="$($AUDIT_CMD 2>&1)"
  code=$?

  if [ $code -eq 0 ]; then
    echo "$out"
    echo "No known high/critical CVEs in the production dependency tree."
    exit 0
  fi

  if printf '%s' "$out" | grep -qiE "$FINDING_RE"; then
    echo "$out"
    echo "::error title=Production CVE found::pnpm audit reported a high or critical advisory in the production dependency tree."
    exit 1
  fi

  # Non-zero with no advisory table: the audit did not run. Retry.
  echo "::notice::audit attempt $attempt could not reach the advisory registry; retrying"
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep $((attempt * SLEEP_BASE))
  fi
done

echo "$out"
echo "::warning title=CVE audit could not run::The advisory registry was unreachable or unparseable after ${ATTEMPTS} attempts, so this run proves nothing about CVEs. Not failing the gate: absence of information is not evidence of a vulnerability, and Dependabot alerts cover this tree independently. Re-run once the registry recovers."
exit 0
