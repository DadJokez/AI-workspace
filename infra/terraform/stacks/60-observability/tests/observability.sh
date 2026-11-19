#!/usr/bin/env bash
# What 60-observability plans inside its module, read from the run of
# observability.tftest.hcl (see ../../../plan_checks.sh for how): that each
# value an earlier stack publishes reaches the alarm, filter or topic it is
# for. The alarm definitions themselves (thresholds, periods, evaluation
# counts) are tested in ../../modules/observability.
#
# No credentials, no state, no AWS calls.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../../../plan_checks.sh
source "$here/../../../plan_checks.sh"

collect_plans "$here/.."

topic='"arn:aws:sns:us-east-1:111122223333:cmp-unit-ops-alerts"'
alarm='module.observability.aws_cloudwatch_metric_alarm.this'

check sandbox "one topic, one subscription, two metric filters, ten alarms, one dashboard" '
  (of_type("aws_sns_topic") | length) == 1 and (of_type("aws_sns_topic_subscription") | length) == 1
  and (of_type("aws_cloudwatch_log_metric_filter") | length) == 2
  and (of_type("aws_cloudwatch_metric_alarm") | length) == 10
  and (of_type("aws_cloudwatch_dashboard") | length) == 1'
check sandbox "the topic is encrypted with the logs key of 00-foundation" '
  resource("module.observability.aws_sns_topic.ops_alerts")
  | .name == "cmp-unit-ops-alerts"
    and .kms_master_key_id == "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001"'
check sandbox "alert_emails become the topic's email subscriptions" "
  of_type(\"aws_sns_topic_subscription\")
  | all(.values.protocol == \"email\" and .values.endpoint == \"ops@example.com\" and .values.topic_arn == $topic)"
check sandbox "the break-glass rule of 00-foundation may publish to the topic, and only from that rule" '
  statement("module.observability.aws_sns_topic_policy.ops_alerts"; "EventBridgeRules")
  | .Principal == {Service: "events.amazonaws.com"} and .Action == "sns:Publish"
    and .Condition == {ArnEquals: {"aws:SourceArn": ["arn:aws:events:us-east-1:111122223333:rule/cmp-unit-break-glass-assumed"]}}'
check sandbox "every alarm notifies the topic when it fires and when it clears" "
  of_type(\"aws_cloudwatch_metric_alarm\") | all(.values.alarm_actions == [$topic] and .values.ok_actions == [$topic])"

check sandbox "each task alarm watches the service 40-services publishes, in the cluster of 30-platform" "
  resource(\"$alarm[\\\"web-below-task-floor\\\"]\").dimensions
    == {ClusterName: \"cmp-unit-cluster\", ServiceName: \"cmp-unit-web\"}
  and resource(\"$alarm[\\\"chat-worker-no-running-tasks\\\"]\").dimensions
    == {ClusterName: \"cmp-unit-cluster\", ServiceName: \"cmp-unit-chat-worker\"}
  and resource(\"$alarm[\\\"memory-worker-no-running-tasks\\\"]\").dimensions
    == {ClusterName: \"cmp-unit-cluster\", ServiceName: \"cmp-unit-memory-worker\"}
  and resource(\"$alarm[\\\"browser-proxy-unavailable\\\"]\").dimensions
    == {ClusterName: \"cmp-unit-cluster\", ServiceName: \"cmp-unit-browser-proxy\"}"
check sandbox "the web floor is web_min" "
  resource(\"$alarm[\\\"web-below-task-floor\\\"]\").threshold == 2"
check sandbox "the load balancer alarms use the ARN suffixes of 30-platform" "
  resource(\"$alarm[\\\"web-unhealthy-hosts\\\"]\").dimensions
    == {LoadBalancer: \"app/cmp-unit-alb/0123456789abcdef\", TargetGroup: \"targetgroup/cmp-unit-web/fedcba9876543210\"}
  and resource(\"$alarm[\\\"web-5xx\\\"]\").dimensions
    == {LoadBalancer: \"app/cmp-unit-alb/0123456789abcdef\", TargetGroup: \"targetgroup/cmp-unit-web/fedcba9876543210\"}
  and resource(\"$alarm[\\\"load-balancer-5xx\\\"]\").dimensions == {LoadBalancer: \"app/cmp-unit-alb/0123456789abcdef\"}"
check sandbox "each metric filter is on its worker's log group" '
  resource("module.observability.aws_cloudwatch_log_metric_filter.run_failed_events").log_group_name == "/comparative/unit/chat-worker"
  and resource("module.observability.aws_cloudwatch_log_metric_filter.memory_capture_failures").log_group_name
    == "/comparative/unit/memory-worker"'
check sandbox "quota_alarm_models become one quota alarm each" '
  resource("module.observability.aws_cloudwatch_metric_alarm.bedrock_token_headroom[\"vendor-model-a-v1-0\"]").threshold == 800000'
check sandbox "the stack creates no role, policy, log group or key (those belong to earlier stacks)" '
  [.resources[] | select(.type | test("^aws_(iam_|kms_|cloudwatch_log_group)"))] | length == 0'

finish
