#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
PROJECT_NAME="${AGENTCORE_BUILD_PROJECT_NAME:-ai-workspace-build}"
ARM_IMAGE="${AGENTCORE_BUILD_IMAGE:-aws/codebuild/amazonlinux-aarch64-standard:3.0}"
ARM_COMPUTE_TYPE="${AGENTCORE_BUILD_COMPUTE_TYPE:-BUILD_GENERAL1_MEDIUM}"

case "$ACTION" in
  start)
    : "${CODEBUILD_RESOLVED_SOURCE_VERSION:?CODEBUILD_RESOLVED_SOURCE_VERSION is required}"
    : "${AGENTCORE_IMAGE_REPO_NAME:?AGENTCORE_IMAGE_REPO_NAME is required}"
    IMAGE_TAG="${COMMIT_TAG:-$CODEBUILD_RESOLVED_SOURCE_VERSION}"

    aws codebuild start-build \
      --region "${AWS_DEFAULT_REGION:-us-east-1}" \
      --project-name "$PROJECT_NAME" \
      --source-version "$CODEBUILD_RESOLVED_SOURCE_VERSION" \
      --buildspec-override buildspec.agentcore.yml \
      --environment-type-override ARM_CONTAINER \
      --image-override "$ARM_IMAGE" \
      --compute-type-override "$ARM_COMPUTE_TYPE" \
      --no-report-build-status-override \
      --environment-variables-override \
        "name=AGENTCORE_IMAGE_REPO_NAME,value=$AGENTCORE_IMAGE_REPO_NAME,type=PLAINTEXT" \
        "name=AGENTCORE_COMMIT_TAG,value=$IMAGE_TAG,type=PLAINTEXT" \
      --query 'build.id' \
      --output text
    ;;

  wait)
    BUILD_ID="${2:?AgentCore build ID is required}"
    POLL_SECONDS="${AGENTCORE_BUILD_POLL_SECONDS:-10}"
    MAX_POLLS="${AGENTCORE_BUILD_MAX_POLLS:-180}"
    MAX_STATUS_ERRORS="${AGENTCORE_BUILD_MAX_STATUS_ERRORS:-3}"
    CONSECUTIVE_STATUS_ERRORS=0

    for ((attempt = 1; attempt <= MAX_POLLS; attempt += 1)); do
      if ! STATUS=$(aws codebuild batch-get-builds \
          --region "${AWS_DEFAULT_REGION:-us-east-1}" \
          --ids "$BUILD_ID" \
          --query 'builds[0].buildStatus' \
          --output text); then
        ((CONSECUTIVE_STATUS_ERRORS += 1))
        if (( CONSECUTIVE_STATUS_ERRORS >= MAX_STATUS_ERRORS )); then
          echo "Could not read AgentCore image build $BUILD_ID status after $CONSECUTIVE_STATUS_ERRORS consecutive attempts." >&2
          exit 1
        fi
        echo "Could not read AgentCore image build $BUILD_ID status; retrying ($CONSECUTIVE_STATUS_ERRORS/$MAX_STATUS_ERRORS)." >&2
        sleep "$POLL_SECONDS"
        continue
      fi
      CONSECUTIVE_STATUS_ERRORS=0

      case "$STATUS" in
        SUCCEEDED)
          echo "AgentCore image build $BUILD_ID succeeded."
          exit 0
          ;;
        FAILED|FAULT|STOPPED|TIMED_OUT)
          LOG_URL=$(aws codebuild batch-get-builds \
            --region "${AWS_DEFAULT_REGION:-us-east-1}" \
            --ids "$BUILD_ID" \
            --query 'builds[0].logs.deepLink' \
            --output text)
          echo "AgentCore image build $BUILD_ID ended with $STATUS. Logs: $LOG_URL" >&2
          exit 1
          ;;
        IN_PROGRESS)
          ;;
        *)
          echo "AgentCore image build $BUILD_ID returned unexpected status: $STATUS" >&2
          exit 1
          ;;
      esac

      sleep "$POLL_SECONDS"
    done

    echo "Timed out waiting for AgentCore image build $BUILD_ID." >&2
    exit 1
    ;;

  *)
    echo "Usage: $0 start | wait <build-id>" >&2
    exit 2
    ;;
esac
