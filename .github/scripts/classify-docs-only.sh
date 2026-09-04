#!/usr/bin/env bash
# classify-docs-only.sh — decide whether a set of changed paths is inert
# documentation, i.e. whether a pull request may take the docs-only fast lane
# (#812) that skips the application gate in ci.yml and product-smoke.yml.
#
# stdin:  NUL-delimited changed paths, as printed by
#         `git diff --name-only --no-renames -z <base> <head>` — the same
#         flags infra/scripts/classify-production-deploy.sh uses. Renames
#         arrive as delete + add, so the old code path is judged too.
# stdout: one verdict line per path, an explanation, then the decision as the
#         LAST line: `docs_only=true` or `docs_only=false`.
# exit:   always 0. The decision is the last line, never the exit status, so a
#         caller cannot mistake a crash for "docs-only".
#
# The allowlist is deliberately narrow (the issue's "conservative classifier"):
# only Markdown under docs/ plus the root README.md is inert. Everything else —
# code, tests, fixtures, dependencies, workflows, infra, scripts, and every
# instruction/prompt file — takes the full gate. Deny rules run first so an
# instruction file that happens to live under docs/ can never be "docs".
# Extending the allowlist means adding a rule here AND a fixture in
# classify-docs-only.test.sh, which the classify job runs before deciding.
set -euo pipefail

verdict() { # allow|deny path reason
  printf '%-5s  %s  (%s)\n' "$1" "$2" "$3"
}

# Prints the verdict; returns 0 when the path is inert documentation.
classify_path() {
  local path="$1" base="${1##*/}"

  # Instruction/prompt files steer Claude, Codex, and skills; they are never
  # inert, wherever they live (CLAUDE.md is the review rubric itself).
  case "$base" in
    SKILL.md | AGENTS.md | CLAUDE.md)
      verdict deny "$path" "instruction file"
      return 1
      ;;
  esac

  case "$path" in
    .github/* | .claude/* | .agents/*)
      verdict deny "$path" "workflow or agent instruction path"
      return 1
      ;;
    # Unit tests assert on this document's wording
    # (apps/web/__tests__/codebuild-source-script.test.ts and
    # ops-alarms-script.test.ts), so editing it must run them.
    docs/PRODUCTION_DEPLOYMENT.md)
      verdict deny "$path" "asserted by unit tests"
      return 1
      ;;
    docs/*.md)
      verdict allow "$path" "docs/**/*.md"
      return 0
      ;;
    README.md)
      verdict allow "$path" "root README.md"
      return 0
      ;;
  esac

  verdict deny "$path" "outside the docs allowlist"
  return 1
}

paths=()
while IFS= read -r -d '' path; do
  paths+=("$path")
done

if ((${#paths[@]} == 0)); then
  echo "no changed paths: nothing to classify, so the full gate runs"
  echo "docs_only=false"
  exit 0
fi

denied=0
for path in "${paths[@]}"; do
  classify_path "$path" || denied=$((denied + 1))
done

if ((denied > 0)); then
  echo "$denied of ${#paths[@]} changed paths need the full gate"
  echo "docs_only=false"
else
  echo "all ${#paths[@]} changed paths are inert documentation"
  echo "docs_only=true"
fi
