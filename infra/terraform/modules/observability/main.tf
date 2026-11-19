# The alarms of one environment, the topic they notify, the two log metric
# filters behind the worker alarms, and a dashboard of the same metrics.
#
# Every threshold, period and evaluation count is the one production runs
# with today: infra/cdk/lib/ai-workspace-ecs-stack.ts for the alarms that
# stack owns, infra/scripts/setup-ops-alarms.sh for the rest.

locals {
  # Log-derived metrics have no dimensions, so the namespace carries the
  # environment: two environments of one account must not count each other's
  # failures.
  worker_namespace = "Comparative/${var.env}/Workers"

  # AWS/ECS LiveTaskCount is the standard count of a service's tasks.
  # RunningTaskCount exists only with Container Insights, which the cluster
  # leaves off. Missing data breaches: a service that reports nothing is the
  # outage these alarms exist for.
  live_tasks = {
    namespace           = "AWS/ECS"
    metric_name         = "LiveTaskCount"
    statistic           = "Minimum"
    period              = 60
    evaluation_periods  = 3
    datapoints_to_alarm = 3
    comparison_operator = "LessThanThreshold"
    treat_missing_data  = "breaching"
    widget              = "ECS live tasks"
  }

  worker_failures = {
    namespace           = local.worker_namespace
    dimensions          = {}
    statistic           = "Sum"
    evaluation_periods  = 1
    datapoints_to_alarm = null
    comparison_operator = "GreaterThanOrEqualToThreshold"
    treat_missing_data  = "notBreaching"
    widget              = "Worker failures"
  }

  http_5xx = {
    namespace           = "AWS/ApplicationELB"
    statistic           = "Sum"
    period              = 300
    evaluation_periods  = 1
    datapoints_to_alarm = null
    threshold           = 5
    comparison_operator = "GreaterThanOrEqualToThreshold"
    treat_missing_data  = "notBreaching"
    widget              = "HTTP 5xx"
  }

  # Alarms on one metric, by the suffix of their name.
  alarms = {
    "web-below-task-floor" = merge(local.live_tasks, {
      description = "The web service has had fewer than ${var.web_min} live ECS tasks for 3 minutes."
      dimensions  = { ClusterName = var.cluster_name, ServiceName = var.service_names.web }
      threshold   = var.web_min
    })
    "browser-proxy-unavailable" = merge(local.live_tasks, {
      description = "The governed AgentCore Browser egress proxy has had no live ECS task for 3 minutes."
      dimensions  = { ClusterName = var.cluster_name, ServiceName = var.service_names.browser_proxy }
      threshold   = 1
    })
    "chat-worker-no-running-tasks" = merge(local.live_tasks, {
      description = "The chat worker has had no live ECS tasks for 3 minutes."
      dimensions  = { ClusterName = var.cluster_name, ServiceName = var.service_names.chat_worker }
      threshold   = 1
    })
    "memory-worker-no-running-tasks" = merge(local.live_tasks, {
      description = "The memory worker has had no live ECS tasks for 3 minutes."
      dimensions  = { ClusterName = var.cluster_name, ServiceName = var.service_names.memory_worker }
      threshold   = 1
    })
    "web-unhealthy-hosts" = {
      description         = "The web target group has had unhealthy hosts for 3 minutes."
      namespace           = "AWS/ApplicationELB"
      metric_name         = "UnHealthyHostCount"
      dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.web_target_group_arn_suffix }
      statistic           = "Maximum"
      period              = 60
      evaluation_periods  = 3
      datapoints_to_alarm = 3
      threshold           = 1
      comparison_operator = "GreaterThanOrEqualToThreshold"
      treat_missing_data  = "notBreaching"
      widget              = "Unhealthy web hosts"
    }
    "web-5xx" = merge(local.http_5xx, {
      description = "Web targets returned at least 5 HTTP 5xx responses in 5 minutes."
      metric_name = "HTTPCode_Target_5XX_Count"
      dimensions  = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.web_target_group_arn_suffix }
    })
    "load-balancer-5xx" = merge(local.http_5xx, {
      description = "The load balancer returned at least 5 HTTP 5xx responses in 5 minutes."
      metric_name = "HTTPCode_ELB_5XX_Count"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
    })
    "memory-capture-failures" = merge(local.worker_failures, {
      description = "The memory worker logged a capture failure in the last 20 minutes."
      metric_name = aws_cloudwatch_log_metric_filter.memory_capture_failures.metric_transformation[0].name
      period      = 1200
      threshold   = 1
    })
    "run-failure-burst" = merge(local.worker_failures, {
      description = "At least 3 terminal chat-worker errors in 15 minutes."
      metric_name = aws_cloudwatch_log_metric_filter.run_failed_events.metric_transformation[0].name
      period      = 900
      threshold   = 3
    })
  }

  # One alarm per watched model, by a name-safe form of its id.
  quota_models = {
    for model in var.quota_alarm_models :
    trim(replace(lower(model.model_id), "/[^a-z0-9]+/", "-"), "-") => merge(model, {
      threshold = model.daily_quota * 0.8
      # Quota accounting, not billing: cache reads do not count, and an output
      # token costs output_burndown quota tokens. The cache-write metric has
      # two spellings, the documented one and the one accounts emit; MAX counts
      # either without counting both.
      expression = "FILL(inputTokens, 0) + MAX([FILL(cacheWriteTokens, 0), FILL(cacheWriteTokenCount, 0)]) + (FILL(outputTokens, 0) * ${model.output_burndown})"
    })
  }

  bedrock_token_metrics = {
    inputTokens          = "InputTokenCount"
    outputTokens         = "OutputTokenCount"
    cacheWriteTokens     = "CacheWriteInputTokens"
    cacheWriteTokenCount = "CacheWriteInputTokenCount"
  }
}

# --- the topic ------------------------------------------------------------------

resource "aws_sns_topic" "ops_alerts" {
  name              = "${var.name_prefix}-ops-alerts"
  kms_master_key_id = var.kms_key_arn
}

# Who may publish. A topic policy replaces the default one, so it names every
# publisher: this environment's alarms, and the EventBridge rules given (the
# break-glass rule of 00-foundation). The account administers the topic
# through IAM.
locals {
  # arn:<partition>:sns:<region>:<account>:<name>
  topic_arn_parts = split(":", aws_sns_topic.ops_alerts.arn)
  topic_account   = local.topic_arn_parts[4]
}

resource "aws_sns_topic_policy" "ops_alerts" {
  arn = aws_sns_topic.ops_alerts.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid       = "AccountAdministration"
          Effect    = "Allow"
          Principal = { AWS = "arn:${local.topic_arn_parts[1]}:iam::${local.topic_account}:root" }
          Action = [
            "sns:AddPermission",
            "sns:DeleteTopic",
            "sns:GetTopicAttributes",
            "sns:ListSubscriptionsByTopic",
            "sns:Publish",
            "sns:RemovePermission",
            "sns:SetTopicAttributes",
            "sns:Subscribe",
          ]
          Resource = aws_sns_topic.ops_alerts.arn
        },
        {
          Sid       = "CloudWatchAlarms"
          Effect    = "Allow"
          Principal = { Service = "cloudwatch.amazonaws.com" }
          Action    = "sns:Publish"
          Resource  = aws_sns_topic.ops_alerts.arn
          Condition = {
            ArnLike      = { "aws:SourceArn" = "arn:${local.topic_arn_parts[1]}:cloudwatch:${local.topic_arn_parts[3]}:${local.topic_account}:alarm:${var.name_prefix}-*" }
            StringEquals = { "aws:SourceAccount" = local.topic_account }
          }
        },
      ],
      length(var.event_rule_arns) == 0 ? [] : [
        {
          Sid       = "EventBridgeRules"
          Effect    = "Allow"
          Principal = { Service = "events.amazonaws.com" }
          Action    = "sns:Publish"
          Resource  = aws_sns_topic.ops_alerts.arn
          Condition = {
            ArnEquals = { "aws:SourceArn" = var.event_rule_arns }
          }
        },
      ],
    )
  })
}

# AWS sends each address a confirmation email; nothing is delivered to it
# until its owner confirms.
resource "aws_sns_topic_subscription" "email" {
  for_each = toset(var.alert_emails)

  topic_arn = aws_sns_topic.ops_alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

# --- log metric filters ---------------------------------------------------------

# apps/web/lib/memory-capture.ts logs "[memory-capture-error] {...}" for a
# failed capture and apps/web/scripts/memory-capture-worker.ts
# "[memory-capture-worker-fatal] {...}" when the worker dies. Either term
# counts.
resource "aws_cloudwatch_log_metric_filter" "memory_capture_failures" {
  name           = "memory-capture-failures"
  log_group_name = var.memory_worker_log_group_name
  pattern        = "?\"memory-capture-error\" ?\"memory-capture-worker-fatal\""

  metric_transformation {
    namespace     = local.worker_namespace
    name          = "MemoryCaptureFailures"
    value         = "1"
    default_value = "0"
  }
}

# apps/web/lib/chat-run-worker.ts logs "[chat-run-worker-error] {...}" for
# every run that ends in a worker error.
resource "aws_cloudwatch_log_metric_filter" "run_failed_events" {
  name           = "run-failed-events"
  log_group_name = var.chat_worker_log_group_name
  pattern        = "\"[chat-run-worker-error]\""

  metric_transformation {
    namespace     = local.worker_namespace
    name          = "RunFailedCount"
    value         = "1"
    default_value = "0"
  }
}

# --- alarms ---------------------------------------------------------------------

# Every alarm notifies the topic when it fires and when it clears.
resource "aws_cloudwatch_metric_alarm" "this" {
  for_each = local.alarms

  alarm_name        = "${var.name_prefix}-${each.key}"
  alarm_description = each.value.description

  namespace   = each.value.namespace
  metric_name = each.value.metric_name
  dimensions  = each.value.dimensions
  statistic   = each.value.statistic
  period      = each.value.period

  evaluation_periods  = each.value.evaluation_periods
  datapoints_to_alarm = each.value.datapoints_to_alarm
  threshold           = each.value.threshold
  comparison_operator = each.value.comparison_operator
  treat_missing_data  = each.value.treat_missing_data

  alarm_actions = [aws_sns_topic.ops_alerts.arn]
  ok_actions    = [aws_sns_topic.ops_alerts.arn]
}

# A sum over one day, evaluated as a sliding window: it can warn briefly after
# the quota resets, but a calendar boundary cannot hide an approaching
# exhaustion.
resource "aws_cloudwatch_metric_alarm" "bedrock_token_headroom" {
  for_each = local.quota_models

  alarm_name        = "${var.name_prefix}-bedrock-${each.key}-token-headroom"
  alarm_description = "Rolling 24-hour token consumption of ${each.value.model_id} reached 80% of the daily quota of ${each.value.daily_quota} tokens."

  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "quotaTokens"
    expression  = each.value.expression
    label       = "Quota-weighted tokens"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = local.bedrock_token_metrics

    content {
      id = metric_query.key

      metric {
        namespace   = "AWS/Bedrock"
        metric_name = metric_query.value
        dimensions  = { ModelId = each.value.model_id }
        stat        = "Sum"
        period      = 86400
      }
    }
  }

  alarm_actions = [aws_sns_topic.ops_alerts.arn]
  ok_actions    = [aws_sns_topic.ops_alerts.arn]
}
