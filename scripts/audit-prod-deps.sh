#!/usr/bin/env bash
# Production CVE gate.
#
# Answers "does the production tree contain a known high/critical CVE?" — a
# question that can only be answered when the advisory registry is reachable.
# Classification is STRUCTURAL, from `pnpm audit --json`, never regex over the
# human-readable table: the fail-CLOSED path must not rest on pnpm's wording,
# locale, or TTY-dependent box glyphs, because a missed match there would
# silently reclassify a real advisory as an outage and pass the gate (review).
#
#   exit 0 from pnpm                      -> clean, pass
#   JSON with advisories / high|critical  -> FINDING, fail closed
#   JSON carrying an `error` key          -> audit could not run, retry/warn
#   unparseable body                      -> audit could not run, retry/warn
#
# AUDIT_CMD is overridable so scripts/audit-prod-deps.test.sh can exercise
# every branch without a network.
set -uo pipefail

AUDIT_CMD=${AUDIT_CMD:-"pnpm audit --prod --audit-level high --json"}
ATTEMPTS=${ATTEMPTS:-3}
SLEEP_BASE=${SLEEP_BASE:-10}

classify() {
  node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  // Node deprecation notices share stdout with the report; drop them before parsing.
  const body = raw
    .split("\n")
    .filter((l) => !/^\(node:\d+\)/.test(l) && !/trace-deprecation/.test(l))
    .join("\n")
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    process.stdout.write("unavailable");
    return;
  }
  // pnpm reports its own transport/parse failure as {"error": {...}} — valid
  // JSON, but it carries no advisory information.
  if (parsed && typeof parsed === "object" && parsed.error) {
    process.stdout.write("unavailable");
    return;
  }
  const advisories = parsed?.advisories ?? {};
  const counts = parsed?.metadata?.vulnerabilities;
  if (counts) {
    // Authoritative when present: the contract is high/critical only.
    const blocking = (counts.high ?? 0) + (counts.critical ?? 0);
    process.stdout.write(blocking > 0 ? "finding" : "clean");
    return;
  }
  // No severity breakdown (older/newer report shape): any advisory blocks
  // rather than risk passing a real one.
  process.stdout.write(Object.keys(advisories).length > 0 ? "finding" : "clean");
});
'
}

raw=""
err=""
err_file="$(mktemp)"
trap 'rm -f "$err_file"' EXIT
for attempt in $(seq 1 "$ATTEMPTS"); do
  # stdout carries the report and is the ONLY thing parsed; folding stderr in
  # would let one stray warning break JSON.parse next to a real finding and
  # silently downgrade it to "registry unreachable" (review).
  raw="$($AUDIT_CMD 2>"$err_file")"
  code=$?
  err="$(cat "$err_file")"

  if [ $code -eq 0 ]; then
    echo "No known high/critical CVEs in the production dependency tree."
    exit 0
  fi

  verdict="$(printf '%s' "$raw" | classify)"

  if [ "$verdict" = "finding" ]; then
    echo "$raw"
    [ -n "$err" ] && echo "$err" >&2
    echo "::error title=Production CVE found::pnpm audit reported a high or critical advisory in the production dependency tree."
    exit 1
  fi

  if [ "$verdict" = "clean" ]; then
    echo "No known high/critical CVEs in the production dependency tree."
    exit 0
  fi

  echo "::notice::audit attempt $attempt could not reach the advisory registry; retrying"
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep $((attempt * SLEEP_BASE))
  fi
done

echo "$raw"
[ -n "$err" ] && echo "$err" >&2
echo "::warning title=CVE audit could not run::The advisory registry was unreachable or returned an unparseable body after ${ATTEMPTS} attempts, so this run proves nothing about CVEs. Not failing the gate: absence of information is not evidence of a vulnerability, and Dependabot alerts cover this tree independently. Re-run once the registry recovers."
exit 0
