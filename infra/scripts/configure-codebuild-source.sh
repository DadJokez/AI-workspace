#!/usr/bin/env bash
set -euo pipefail

region=${AWS_DEFAULT_REGION:-${AWS_REGION:-}}
project_name=${CODEBUILD_PROJECT_NAME:-ai-workspace-build}
agentcore_project_name=${AGENTCORE_BUILD_PROJECT_NAME:-ai-workspace-agentcore-build}
clone_depth=${CODEBUILD_GIT_CLONE_DEPTH:-0}
concurrent_limit=${CODEBUILD_CONCURRENT_BUILD_LIMIT:-1}
agentcore_buildspec=${AGENTCORE_BUILD_SPEC:-buildspec.agentcore.yml}
agentcore_image=${AGENTCORE_BUILD_IMAGE:-aws/codebuild/amazonlinux-aarch64-standard:3.0}
agentcore_compute_type=${AGENTCORE_BUILD_COMPUTE_TYPE:-BUILD_GENERAL1_MEDIUM}

if [[ -z "$region" ]]; then
  echo "AWS_DEFAULT_REGION or AWS_REGION is required." >&2
  exit 1
fi

if [[ "$project_name" == "$agentcore_project_name" ]]; then
  echo "The production and AgentCore CodeBuild projects must be different to avoid a single-flight deadlock." >&2
  exit 1
fi

if [[ ! "$clone_depth" =~ ^([0-9]|1[0-9]|2[0-5])$ ]]; then
  echo "CODEBUILD_GIT_CLONE_DEPTH must be an integer from 0 through 25." >&2
  exit 1
fi

if [[ ! "$concurrent_limit" =~ ^[1-9][0-9]*$ ]]; then
  echo "CODEBUILD_CONCURRENT_BUILD_LIMIT must be a positive integer." >&2
  exit 1
fi

project_json=$(aws codebuild batch-get-projects \
  --region "$region" \
  --names "$project_name" "$agentcore_project_name" \
  --output json)

if [[ "$(jq -r --arg name "$project_name" \
    '[.projects[] | select(.name == $name)] | length' \
    <<< "$project_json")" != "1" ]] ||
  [[ "$(jq -r --arg name "$agentcore_project_name" \
    '[.projects[] | select(.name == $name)] | length' \
    <<< "$project_json")" != "1" ]] ||
  [[ "$(jq -r '.projectsNotFound // [] | length' <<< "$project_json")" != "0" ]]; then
  echo "Expected CodeBuild projects $project_name and $agentcore_project_name before reconciling the production project." >&2
  exit 1
fi

if ! jq -e \
  --arg name "$agentcore_project_name" \
  --arg buildspec "$agentcore_buildspec" \
  --arg image "$agentcore_image" \
  --arg compute_type "$agentcore_compute_type" \
  '
    .projects[]
    | select(.name == $name)
    | .source.type == "GITHUB"
      and .source.gitCloneDepth == 1
      and .source.buildspec == $buildspec
      and .source.reportBuildStatus == false
      and .environment.type == "ARM_CONTAINER"
      and .environment.image == $image
      and .environment.computeType == $compute_type
      and .environment.privilegedMode == true
      and .artifacts.type == "NO_ARTIFACTS"
      and .concurrentBuildLimit == 1
  ' <<< "$project_json" >/dev/null; then
  child_summary=$(jq -c \
    --arg name "$agentcore_project_name" \
    '
      .projects[]
      | select(.name == $name)
      | {
          name,
          source: {
            type: .source.type,
            gitCloneDepth: .source.gitCloneDepth,
            buildspec: .source.buildspec,
            reportBuildStatus: .source.reportBuildStatus
          },
          environment: {
            type: .environment.type,
            image: .environment.image,
            computeType: .environment.computeType,
            privilegedMode: .environment.privilegedMode
          },
          artifactsType: .artifacts.type,
          concurrentBuildLimit
        }
    ' <<< "$project_json")
  echo "AgentCore child project verification failed; refusing to make the production project single-flight. Found: $child_summary" >&2
  exit 1
fi

source_json=$(jq -c \
  --arg name "$project_name" \
  --argjson clone_depth "$clone_depth" \
  '.projects[] | select(.name == $name) | .source | .gitCloneDepth = $clone_depth' \
  <<< "$project_json")

aws codebuild update-project \
  --region "$region" \
  --name "$project_name" \
  --source "$source_json" \
  --concurrent-build-limit "$concurrent_limit" \
  >/dev/null

verified_json=$(aws codebuild batch-get-projects \
  --region "$region" \
  --names "$project_name" \
  --output json)

if [[ "$(jq -r '.projects | length' <<< "$verified_json")" != "1" ]] ||
  [[ "$(jq -r '.projectsNotFound // [] | length' <<< "$verified_json")" != "0" ]]; then
  echo "Could not verify CodeBuild project $project_name after updating it." >&2
  exit 1
fi

# Live-verified 2026-07-23 against ai-workspace-build: CodeBuild returns the
# full-history value as numeric 0. Keep an absent field fail-closed because a
# response-shape change is ambiguous and should not be reported as reconciled.
verified_depth=$(jq -r '.projects[0].source.gitCloneDepth // empty' \
  <<< "$verified_json")
verified_concurrent_limit=$(jq -r \
  '.projects[0].concurrentBuildLimit // empty' <<< "$verified_json")

if [[ "$verified_depth" != "$clone_depth" ]]; then
  echo "CodeBuild checkout verification failed: expected gitCloneDepth=$clone_depth, got ${verified_depth:-missing}." >&2
  exit 1
fi

if [[ "$verified_concurrent_limit" != "$concurrent_limit" ]]; then
  echo "CodeBuild concurrency verification failed: expected concurrentBuildLimit=$concurrent_limit, got ${verified_concurrent_limit:-missing}." >&2
  exit 1
fi

source_type=$(jq -r '.projects[0].source.type' <<< "$verified_json")
echo "CodeBuild parent reconciled: project=$project_name region=$region sourceType=$source_type gitCloneDepth=$verified_depth concurrentBuildLimit=$verified_concurrent_limit agentCoreChild=$agentcore_project_name"
