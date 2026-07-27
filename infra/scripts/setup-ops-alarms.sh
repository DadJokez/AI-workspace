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
#   2. Worker-liveness alarms: LiveTaskCount < 1 for chat-worker and
#      memory-worker (the "background lane is silently dead" detector,
#      without requiring Container Insights).
#   3. Web target 5xx and load-balancer 5xx alarms.
#   4. A run-failure log metric filter + alarm on the chat-worker log group
#      (>=3 terminal worker errors in 15 minutes).
#
# Ownership: alarms that depend on a CDK-managed resource live in the stack,
# not here. `ai-workspace-web-unhealthy-hosts` (target group) and
# `ai-workspace-web-below-task-floor` (#568, must track the stack's autoscaling
# minCapacity) are owned by infra/cdk/lib/ai-workspace-ecs-stack.ts. This
# script used to also write the unhealthy-hosts alarm under the same name with
# different settings, so whichever ran last silently won — it no longer touches
# it. Everything above needs an ALB/target-group lookup or a log group that
# outlives the stack, so it stays operator-applied.
set -euo pipefail

: "${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION is required}"
: "${OPS_ALERT_EMAIL:?OPS_ALERT_EMAIL is required}"

CLUSTER="${ECS_CLUSTER_NAME:-ai-workspace-prod}"
TOPIC_NAME="ai-workspace-ops-alerts"

echo "1/4 SNS topic + subscription..."
TOPIC_ARN=$(aws sns create-topic --name "$TOPIC_NAME" --query TopicArn --output text)
SUBSCRIPTION_ARN=$(aws sns list-subscriptions-by-topic \
  --topic-arn "$TOPIC_ARN" \
  --query "Subscriptions[?Protocol=='email' && Endpoint=='${OPS_ALERT_EMAIL}'].SubscriptionArn | [0]" \
  --output text)
if [ -z "$SUBSCRIPTION_ARN" ] || [ "$SUBSCRIPTION_ARN" = "None" ]; then
  aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol email \
    --notification-endpoint "$OPS_ALERT_EMAIL" --output text >/dev/null
  echo "   topic: $TOPIC_ARN (confirmation requested for $OPS_ALERT_EMAIL)"
elif [ "$SUBSCRIPTION_ARN" = "PendingConfirmation" ]; then
  echo "   topic: $TOPIC_ARN (confirmation is still pending for $OPS_ALERT_EMAIL)"
else
  echo "   topic: $TOPIC_ARN ($OPS_ALERT_EMAIL is already subscribed)"
fi

echo "2/4 Worker-liveness alarms..."
for svc in ai-workspace-chat-worker ai-workspace-memory-worker; do
  # LiveTaskCount is the standard AWS/ECS count of ACTIVATING, RUNNING, and
  # DEACTIVATING tasks. RunningTaskCount is a different, Container
  # Insights-only metric. See:
  # https://docs.aws.amazon.com/AmazonECS/latest/developerguide/available-metrics.html
  aws cloudwatch put-metric-alarm \
    --alarm-name "${svc}-no-running-tasks" \
    --alarm-description "#509: ${svc} has had no live ECS tasks for 3 minutes." \
    --namespace AWS/ECS --metric-name LiveTaskCount \
    --dimensions Name=ClusterName,Value="$CLUSTER" Name=ServiceName,Value="$svc" \
    --statistic Minimum --period 60 --evaluation-periods 3 \
    --datapoints-to-alarm 3 --threshold 1 \
    --comparison-operator LessThanThreshold \
    --treat-missing-data breaching \
    --alarm-actions "$TOPIC_ARN" --ok-actions "$TOPIC_ARN"
done

echo "3/4 Web ALB alarms..."
ALB_ARN=$(aws elbv2 describe-load-balancers \
  --query "LoadBalancers[?contains(LoadBalancerName, 'AiWork') || contains(LoadBalancerName, 'ai-workspace')].LoadBalancerArn | [0]" \
  --output text)
if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" = "None" ]; then
  echo "ERROR: could not resolve the Comparative load balancer." >&2
  exit 1
fi
ALB_FULL_NAME=${ALB_ARN#*loadbalancer/}

TARGET_GROUP_ARN=$(aws elbv2 describe-target-groups \
  --load-balancer-arn "$ALB_ARN" \
  --query "TargetGroups[?HealthCheckPath=='/api/health'].TargetGroupArn | [0]" \
  --output text)
if [ -z "$TARGET_GROUP_ARN" ] || [ "$TARGET_GROUP_ARN" = "None" ]; then
  echo "ERROR: could not resolve the web target group for $ALB_ARN." >&2
  exit 1
fi
TARGET_GROUP_FULL_NAME=${TARGET_GROUP_ARN#*targetgroup/}

aws cloudwatch put-metric-alarm \
  --alarm-name "ai-workspace-web-5xx" \
  --alarm-description "#509: web targets returned at least 5 HTTP 5xx responses in 5 minutes." \
  --namespace AWS/ApplicationELB --metric-name HTTPCode_Target_5XX_Count \
  --dimensions Name=LoadBalancer,Value="$ALB_FULL_NAME" Name=TargetGroup,Value="$TARGET_GROUP_FULL_NAME" \
  --statistic Sum --period 300 --evaluation-periods 1 \
  --threshold 5 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC_ARN" --ok-actions "$TOPIC_ARN"

aws cloudwatch put-metric-alarm \
  --alarm-name "ai-workspace-load-balancer-5xx" \
  --alarm-description "#509: the load balancer returned at least 5 HTTP 5xx responses in 5 minutes." \
  --namespace AWS/ApplicationELB --metric-name HTTPCode_ELB_5XX_Count \
  --dimensions Name=LoadBalancer,Value="$ALB_FULL_NAME" \
  --statistic Sum --period 300 --evaluation-periods 1 \
  --threshold 5 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC_ARN" --ok-actions "$TOPIC_ARN"

echo "4/4 Run-failure metric filter + alarm..."
LOG_GROUP="/ecs/ai-workspace/chat-worker"
aws logs put-metric-filter \
  --log-group-name "$LOG_GROUP" \
  --filter-name "run-failed-events" \
  --filter-pattern '"[chat-run-worker-error]"' \
  --metric-transformations \
    metricName=RunFailedCount,metricNamespace=AiWorkspace,metricValue=1,defaultValue=0
aws cloudwatch put-metric-alarm \
  --alarm-name "ai-workspace-run-failure-burst" \
  --alarm-description "#509: at least 3 terminal chat-worker errors in 15 minutes." \
  --namespace AiWorkspace --metric-name RunFailedCount \
  --statistic Sum --period 900 --evaluation-periods 1 \
  --threshold 3 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC_ARN"

echo "Done. Confirm any pending SNS email subscription, then run 'aws cloudwatch describe-alarms --alarm-name-prefix ai-workspace' to verify."
