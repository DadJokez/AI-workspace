#!/usr/bin/env bash
set -euo pipefail

DECISION_FILE=${1:-/tmp/ai-workspace-deploy-decision.env}

write_decision() {
  printf 'SKIP_PRODUCTION_DEPLOY=%s\n' "$1" > "$DECISION_FILE"
}

require_deploy() {
  echo "full deploy required: $1"
  write_decision 0
  exit 0
}

if [[ "${CODEBUILD_WEBHOOK_EVENT:-}" != "PUSH" ]]; then
  require_deploy "build was not triggered by a push webhook"
fi

if [[ "${CODEBUILD_WEBHOOK_TRIGGER:-}" != "branch/main" ]]; then
  require_deploy "webhook target was not branch/main"
fi

previous_commit=${CODEBUILD_WEBHOOK_PREV_COMMIT:-}
current_commit=${CODEBUILD_RESOLVED_SOURCE_VERSION:-}
sha_pattern='^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$'

if [[ ! "$previous_commit" =~ $sha_pattern ]]; then
  require_deploy "previous commit SHA is missing or invalid"
fi

if [[ ! "$current_commit" =~ $sha_pattern ]]; then
  require_deploy "resolved source SHA is missing or invalid"
fi

if [[ "$previous_commit" =~ ^0+$ ]]; then
  require_deploy "push created the branch and has no previous commit"
fi

if ! git cat-file -e "${current_commit}^{commit}" 2>/dev/null; then
  require_deploy "resolved source commit is unavailable"
fi

if ! git cat-file -e "${previous_commit}^{commit}" 2>/dev/null; then
  echo "Previous commit is not in the local checkout; fetching it from origin."
  if ! git fetch --no-tags --depth=1 origin "$previous_commit"; then
    require_deploy "previous commit could not be fetched"
  fi
fi

diff_file=$(mktemp)
trap 'rm -f "$diff_file"' EXIT
if ! git diff --name-only --no-renames -z \
  "$previous_commit" "$current_commit" > "$diff_file"; then
  require_deploy "changed paths could not be classified"
fi

changed_paths=()
while IFS= read -r -d '' path; do
  changed_paths+=("$path")
done < "$diff_file"

if (( ${#changed_paths[@]} == 0 )); then
  require_deploy "commit range contains no changed paths"
fi

echo "Changed paths:"
docs_only=1
for path in "${changed_paths[@]}"; do
  printf ' - %s\n' "$path"
  case "$path" in
    docs/*|README.md|AGENTS.md|CLAUDE.md)
      ;;
    *)
      docs_only=0
      ;;
  esac
done

if (( docs_only == 0 )); then
  require_deploy "one or more changed paths affect the product or deployment"
fi

write_decision 1
echo "docs-only: deployment skipped"
