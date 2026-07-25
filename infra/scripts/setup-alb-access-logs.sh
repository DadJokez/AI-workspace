#!/usr/bin/env bash
# Reconcile the S3 dependency used by AiWorkspaceEcsStack ALB access logging.
# CDK references this existing bucket but deliberately does not adopt it, so
# this reviewed script is the reproducible bootstrap and repair path.
#
#   AWS_DEFAULT_REGION=us-east-1 \
#     ./infra/scripts/setup-alb-access-logs.sh
#
# The default bucket name matches the CDK stack. Override it only when the stack
# uses the matching aiWorkspace:albAccessLogBucketName context value.
#
# API-shape provenance (verified 2026-07-25 against the LIVE production
# bucket, which has ALB log objects landing): the
# `logdelivery.elasticloadbalancing.amazonaws.com` service principal with
# SourceAccount/SourceArn conditions is the policy the working us-east-1
# bucket carries (the legacy regional ELB account-id principal is not
# needed), and `BlockedEncryptionTypes: ["SSE-C"]` is a current
# ServerSideEncryptionRule member (added to S3 in 2025), accepted and active
# on that bucket. `get-bucket-policy` / `get-bucket-encryption` on the prod
# bucket are the reference if these shapes are ever in doubt.
set -euo pipefail

: "${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION is required}"

AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
BUCKET_NAME="${ALB_ACCESS_LOG_BUCKET_NAME:-ai-workspace-alb-logs-${AWS_ACCOUNT_ID}-${AWS_DEFAULT_REGION}}"
LOG_PREFIX="${ALB_ACCESS_LOG_PREFIX:-alb}"

if aws s3api head-bucket --bucket "$BUCKET_NAME" >/dev/null 2>&1; then
  echo "Using existing ALB access-log bucket: $BUCKET_NAME"
elif [ "$AWS_DEFAULT_REGION" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "$BUCKET_NAME"
else
  aws s3api create-bucket \
    --bucket "$BUCKET_NAME" \
    --create-bucket-configuration "LocationConstraint=${AWS_DEFAULT_REGION}"
fi

aws s3api put-public-access-block \
  --bucket "$BUCKET_NAME" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

aws s3api put-bucket-ownership-controls \
  --bucket "$BUCKET_NAME" \
  --ownership-controls '{"Rules":[{"ObjectOwnership":"BucketOwnerEnforced"}]}'

aws s3api put-bucket-encryption \
  --bucket "$BUCKET_NAME" \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":false,"BlockedEncryptionTypes":{"EncryptionType":["SSE-C"]}}]}'

BUCKET_POLICY=$(jq -cn \
  --arg bucket "$BUCKET_NAME" \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg region "$AWS_DEFAULT_REGION" \
  --arg prefix "$LOG_PREFIX" \
  '{
    Version: "2012-10-17",
    Statement: [{
      Sid: "AllowApplicationLoadBalancerLogDelivery",
      Effect: "Allow",
      Principal: {Service: "logdelivery.elasticloadbalancing.amazonaws.com"},
      Action: "s3:PutObject",
      Resource: ("arn:aws:s3:::" + $bucket + "/" + $prefix + "/AWSLogs/" + $account + "/*"),
      Condition: {
        StringEquals: {"aws:SourceAccount": $account},
        ArnLike: {"aws:SourceArn": ("arn:aws:elasticloadbalancing:" + $region + ":" + $account + ":loadbalancer/*")}
      }
    }]
  }')
aws s3api put-bucket-policy --bucket "$BUCKET_NAME" --policy "$BUCKET_POLICY"

LIFECYCLE_CONFIGURATION=$(jq -cn \
  --arg prefix "${LOG_PREFIX}/AWSLogs/" \
  '{
    Rules: [{
      ID: "ExpireAlbLogsAfter30Days",
      Status: "Enabled",
      Filter: {Prefix: $prefix},
      Expiration: {Days: 30},
      AbortIncompleteMultipartUpload: {DaysAfterInitiation: 7}
    }]
  }')
aws s3api put-bucket-lifecycle-configuration \
  --bucket "$BUCKET_NAME" \
  --lifecycle-configuration "$LIFECYCLE_CONFIGURATION"

echo "ALB access-log bucket reconciled: s3://${BUCKET_NAME}/${LOG_PREFIX}/"
