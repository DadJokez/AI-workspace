#!/usr/bin/env bash
set -euo pipefail

region=${AWS_DEFAULT_REGION:-${AWS_REGION:-}}
project_name=${CODEBUILD_PROJECT_NAME:-ai-workspace-build}
clone_depth=${CODEBUILD_GIT_CLONE_DEPTH:-0}

if [[ -z "$region" ]]; then
  echo "AWS_DEFAULT_REGION or AWS_REGION is required." >&2
  exit 1
fi

if [[ ! "$clone_depth" =~ ^([0-9]|1[0-9]|2[0-5])$ ]]; then
  echo "CODEBUILD_GIT_CLONE_DEPTH must be an integer from 0 through 25." >&2
  exit 1
fi

project_json=$(aws codebuild batch-get-projects \
  --region "$region" \
  --names "$project_name" \
  --output json)

if [[ "$(jq -r '.projects | length' <<< "$project_json")" != "1" ]] ||
  [[ "$(jq -r '.projectsNotFound // [] | length' <<< "$project_json")" != "0" ]]; then
  echo "Expected exactly one CodeBuild project named $project_name." >&2
  exit 1
fi

source_json=$(jq -c \
  --argjson clone_depth "$clone_depth" \
  '.projects[0].source | .gitCloneDepth = $clone_depth' \
  <<< "$project_json")

aws codebuild update-project \
  --region "$region" \
  --name "$project_name" \
  --source "$source_json" \
  >/dev/null

verified_json=$(aws codebuild batch-get-projects \
  --region "$region" \
  --names "$project_name" \
  --output json)
# Live-verified 2026-07-23 against ai-workspace-build: CodeBuild returns the
# full-history value as numeric 0. Keep an absent field fail-closed because a
# response-shape change is ambiguous and should not be reported as reconciled.
verified_depth=$(jq -r '.projects[0].source.gitCloneDepth // empty' \
  <<< "$verified_json")

if [[ "$verified_depth" != "$clone_depth" ]]; then
  echo "CodeBuild checkout verification failed: expected gitCloneDepth=$clone_depth, got ${verified_depth:-missing}." >&2
  exit 1
fi

source_type=$(jq -r '.projects[0].source.type' <<< "$verified_json")
echo "CodeBuild checkout reconciled: project=$project_name region=$region sourceType=$source_type gitCloneDepth=$verified_depth"
