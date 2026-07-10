#!/usr/bin/env bash

set -euo pipefail

: "${AGENTCORE_RUNTIME_ID:?AGENTCORE_RUNTIME_ID is required}"
: "${AGENTCORE_IMAGE_URI:?AGENTCORE_IMAGE_URI is required}"

AWS_DEPLOY_REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-}}"
: "${AWS_DEPLOY_REGION:?AWS_DEFAULT_REGION or AWS_REGION is required}"

POLL_SECONDS="${AGENTCORE_UPDATE_POLL_SECONDS:-10}"
MAX_POLLS="${AGENTCORE_UPDATE_MAX_POLLS:-60}"

current_config="$(
  aws bedrock-agentcore-control get-agent-runtime \
    --region "$AWS_DEPLOY_REGION" \
    --agent-runtime-id "$AGENTCORE_RUNTIME_ID" \
    --output json
)"

if ! jq -e '.roleArn | type == "string" and length > 0' >/dev/null <<<"$current_config"; then
  echo "AgentCore runtime is missing a roleArn; refusing to replace its configuration." >&2
  exit 1
fi
if ! jq -e '.networkConfiguration | type == "object"' >/dev/null <<<"$current_config"; then
  echo "AgentCore runtime is missing networkConfiguration; refusing to replace its configuration." >&2
  exit 1
fi

payload_file="$(mktemp)"
trap 'rm -f "$payload_file"' EXIT
chmod 600 "$payload_file"

# update-agent-runtime replaces the runtime configuration instead of patching
# it. Preserve every optional field accepted by the current API when present,
# and omit absent/null fields so they cannot be passed as the literal `null`.
jq \
  --arg runtime_id "$AGENTCORE_RUNTIME_ID" \
  --arg image_uri "$AGENTCORE_IMAGE_URI" \
  '
    def optional_field($source; $key):
      if $source[$key] == null then {} else {($key): $source[$key]} end;

    . as $source
    | {
        agentRuntimeId: $runtime_id,
        agentRuntimeArtifact: {
          containerConfiguration: { containerUri: $image_uri }
        },
        roleArn: $source.roleArn,
        networkConfiguration: $source.networkConfiguration
      }
      + reduce (
          [
            "description",
            "authorizerConfiguration",
            "requestHeaderConfiguration",
            "protocolConfiguration",
            "lifecycleConfiguration",
            "metadataConfiguration",
            "environmentVariables",
            "filesystemConfigurations"
          ][]
        ) as $key ({}; . + optional_field($source; $key))
  ' <<<"$current_config" >"$payload_file"

update_response="$(
  aws bedrock-agentcore-control update-agent-runtime \
    --region "$AWS_DEPLOY_REGION" \
    --cli-input-json "file://$payload_file" \
    --output json
)"
target_version="$(jq -er '.agentRuntimeVersion | strings | select(length > 0)' <<<"$update_response")"

for ((poll = 1; poll <= MAX_POLLS; poll += 1)); do
  runtime_state="$(
    aws bedrock-agentcore-control get-agent-runtime \
      --region "$AWS_DEPLOY_REGION" \
      --agent-runtime-id "$AGENTCORE_RUNTIME_ID" \
      --agent-runtime-version "$target_version" \
      --output json
  )"
  status="$(jq -r '.status // "UNKNOWN"' <<<"$runtime_state")"

  if [[ "$status" == "READY" ]]; then
    echo "AgentCore runtime $AGENTCORE_RUNTIME_ID version $target_version is ready."
    exit 0
  fi
  if [[ "$status" == *"FAILED"* ]]; then
    echo "AgentCore runtime $AGENTCORE_RUNTIME_ID version $target_version entered $status." >&2
    exit 1
  fi

  sleep "$POLL_SECONDS"
done

echo "Timed out waiting for AgentCore runtime $AGENTCORE_RUNTIME_ID version $target_version." >&2
exit 1
