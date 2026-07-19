#!/usr/bin/env bash
# #449: the ops-floor alarm set. Idempotent — safe to re-run; every resource
# is created-or-updated by name. Run once by an operator with console/CLI
# access (this is deliberately a reviewed script Rob runs, not something the
# app or CI executes):
#
#   AWS_DEFAULT_REGION=us-east-1 OPS_ALERT_EMAIL=rob@lindmark.co \
#     ./infra/scripts/setup-ops-alarms.sh
#
# Creates:
#   1. SNS topic ai-workspace-ops-alerts + email subscription (confirm via
#      the email AWS sends).
#   2. Worker-liveness alarms: RunningTaskCount < 1 for chat-worker and
#      memory-worker (the "background lane is silently dead" detector).
#   3. Web 5xx alarm on the ALB (>=5 5xx in 5 minutes).
#   4. A run-failure log metric filter + alarm on the chat-worker log group
#      (>=3 run_failed events in 15 minutes — the poison-pill detector until
#      #462's quarantine lands).
set -euo pipefail

: "${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION is required}"
: "${OPS_ALERT_EMAIL:?OPS_ALERT_EMAIL is required}"

CLUSTER="${ECS_CLUSTER_NAME:-ai-workspace-prod}"
TOPIC_NAME="ai-workspace-ops-alerts"

echo "1/4 SNS topic + subscription..."
TOPIC_ARN=$(aws sns create-topic --name "$TOPIC_NAME" --query TopicArn --output text)
aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol email \
  --notification-endpoint "$OPS_ALERT_EMAIL" --output text >/dev/null || true
echo "   topic: $TOPIC_ARN (confirm the subscription email if this is the first run)"

echo "2/4 Worker-liveness alarms..."
for svc in ai-workspace-chat-worker ai-workspace-memory-worker; do
  aws cloudwatch put-metric-alarm \
    --alarm-name "${svc}-no-running-tasks" \
    --alarm-description "#449: ${svc} has no running tasks — the background lane is dead." \
    --namespace AWS/ECS --metric-name RunningTaskCount \
    --dimensions Name=ClusterName,Value="$CLUSTER" Name=ServiceName,Value="$svc" \
    --statistic Minimum --period 60 --evaluation-periods 3 \
    --threshold 1 --comparison-operator LessThanThreshold \
    --treat-missing-data breaching \
    --alarm-actions "$TOPIC_ARN" --ok-actions "$TOPIC_ARN"
done

echo "3/4 Web ALB 5xx alarm..."
ALB_FULL_NAME=$(aws elbv2 describe-load-balancers \
  --query "LoadBalancers[?contains(LoadBalancerName, 'AiWork') || contains(LoadBalancerName, 'ai-workspace')].LoadBalancerArn | [0]" \
  --output text | sed 's|.*loadbalancer/||')
if [ -n "$ALB_FULL_NAME" ] && [ "$ALB_FULL_NAME" != "None" ]; then
  aws cloudwatch put-metric-alarm \
    --alarm-name "ai-workspace-web-5xx" \
    --alarm-description "#449: web tier returning 5xx." \
    --namespace AWS/ApplicationELB --metric-name HTTPCode_Target_5XX_Count \
    --dimensions Name=LoadBalancer,Value="$ALB_FULL_NAME" \
    --statistic Sum --period 300 --evaluation-periods 1 \
    --threshold 5 --comparison-operator GreaterThanOrEqualToThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "$TOPIC_ARN"
else
  echo "   WARN: could not resolve the ALB name automatically — create ai-workspace-web-5xx manually against the web ALB."
fi

echo "4/4 Run-failure metric filter + alarm..."
LOG_GROUP="/ecs/ai-workspace-chat-worker"
aws logs put-metric-filter \
  --log-group-name "$LOG_GROUP" \
  --filter-name "run-failed-events" \
  --filter-pattern '"run_failed"' \
  --metric-transformations \
    metricName=RunFailedCount,metricNamespace=AiWorkspace,metricValue=1,defaultValue=0
aws cloudwatch put-metric-alarm \
  --alarm-name "ai-workspace-run-failure-burst" \
  --alarm-description "#449: >=3 failed runs in 15 minutes — investigate before testers notice (poison-pill detector until #462)." \
  --namespace AiWorkspace --metric-name RunFailedCount \
  --statistic Sum --period 900 --evaluation-periods 1 \
  --threshold 3 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC_ARN"

echo "Done. Confirm the SNS email subscription, then 'aws cloudwatch describe-alarms --alarm-name-prefix ai-workspace' to verify."
