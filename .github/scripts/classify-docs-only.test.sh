#!/usr/bin/env bash
# Fixture matrix for the docs-only fast lane classifier (#812).
#
# The fail-CLOSED direction matters most: nothing that can change code,
# tests, dependencies, workflows, infrastructure, or an agent's instructions
# may ever classify as docs-only. The allow cases exist so the lane actually
# opens for the documentation PRs it was built for.
set -uo pipefail
cd "$(dirname "$0")/../.."
pass=0
fail=0

check() { # name expected(true|false) paths...
  local name="$1" want="$2"
  shift 2
  local out got
  if (($# == 0)); then
    out="$(bash .github/scripts/classify-docs-only.sh </dev/null 2>&1)"
  else
    out="$(printf '%s\0' "$@" | bash .github/scripts/classify-docs-only.sh 2>&1)"
  fi
  got="$(printf '%s\n' "$out" | tail -n 1)"
  if [ "$got" = "docs_only=$want" ]; then
    echo "  ok   $name"
    pass=$((pass + 1))
  else
    echo "  FAIL $name (want docs_only=$want, got '$got')"
    printf '%s\n' "$out" | sed 's/^/       /'
    fail=$((fail + 1))
  fi
}

echo "docs-only classification:"

# --- docs lane: the PRs this exists for ---
check "docs/BUILD_QUEUE.md alone" true docs/BUILD_QUEUE.md
check "two ordinary files under docs/" true \
  docs/adr/0051-docs-only-fast-lane.md docs/research/HARNESS_RESEARCH_2026-08.md
check "README.md alone (explicitly allowlisted)" true README.md
check "docs plus README" true docs/ROADMAP.md README.md
check "deleted docs page (a path is a path)" true docs/STRETCH_GOALS_2026-07.md

# --- full lane: anything that can change behavior ---
check "docs plus app code" false docs/foo.md apps/web/app/page.tsx
check "renamed code file beside a doc (old + new path)" false \
  apps/web/lib/old.ts apps/web/lib/new.ts docs/x.md
check "deleted migration" false packages/db/migrations/0001_init.sql
check "package.json" false package.json
check "pnpm-lock.yaml" false pnpm-lock.yaml
check "workflow file" false .github/workflows/ci.yml
check "issue template under .github" false .github/ISSUE_TEMPLATE/bug.md
check "CLAUDE.md (review rubric)" false CLAUDE.md
check "AGENTS.md (Codex instructions)" false AGENTS.md
check ".claude/commands/goal.md" false .claude/commands/goal.md
check ".agents skill" false .agents/skills/comparative-browser-evals/SKILL.md
check "package SKILL.md" false packages/umber/SKILL.md
check "SKILL.md hidden under docs/" false docs/skills/foo/SKILL.md
check "CLAUDE.md hidden under docs/" false docs/CLAUDE.md
check "docs/PRODUCTION_DEPLOYMENT.md (asserted by unit tests)" false \
  docs/PRODUCTION_DEPLOYMENT.md
check "script under docs/" false docs/alpha-guide/capture-screenshots.ts
check "non-markdown under docs/" false \
  docs/agentcore-migration/specs/create-harness-examples/aws-ops-agent.json
check "root doc not on the allowlist" false PLAN.md
check "golden transcript markdown (test fixture)" false \
  packages/evals/golden-transcripts/example.md
check "spec markdown" false specs/001-runtime-v2-autopilot/spec.md
check "uppercase extension" false docs/foo.MD
check "capitalised directory" false Docs/foo.md
check "docs-looking prefix without the separator" false docsx/foo.md docs.md
check "path containing a newline" false $'docs/a.md\npackage.json'
check "empty path" false ""
check "no changed paths" false

echo
echo "$pass passed, $fail failed"
[ "$fail" = "0" ]
