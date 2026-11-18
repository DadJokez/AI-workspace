# Plan-only tests with a mocked AWS provider: no credentials, no AWS calls.
#
# The run "production_values" carries over what
# apps/web/__tests__/ecs-cdk-alarms.test.ts asserts of the CDK stack and
# apps/web/__tests__/ops-alarms-script.test.ts of setup-ops-alarms.sh, the two
# sources of the alarms this module replaces. Its inputs are production's: a
# web floor of two tasks and the one model production watches.

mock_provider "aws" {
  override_during = plan

  # Declaring a resource type here is what makes its computed attributes
  # available while planning.
  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-east-1:111122223333:cmp-unit-ops-alerts"
    }
  }
}

variables {
  env         = "unit"
  name_prefix = "cmp-unit"
  aws_region  = "us-east-1"

  kms_key_arn  = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001"
  alert_emails = ["ops@example.com"]

  cluster_name = "cmp-unit-cluster"
  service_names = {
    web           = "cmp-unit-web"
    chat_worker   = "cmp-unit-chat-worker"
    memory_worker = "cmp-unit-memory-worker"
    browser_proxy = "cmp-unit-browser-proxy"
  }
  alb_arn_suffix               = "app/cmp-unit-alb/0123456789abcdef"
  web_target_group_arn_suffix  = "targetgroup/cmp-unit-web/fedcba9876543210"
  chat_worker_log_group_name   = "/comparative/unit/chat-worker"
  memory_worker_log_group_name = "/comparative/unit/memory-worker"

  web_min = 2
  quota_alarm_models = [
    { model_id = "us.anthropic.claude-sonnet-4-5-20250929-v1:0", daily_quota = 5400000, output_burndown = 5 },
  ]
}

run "production_values" {
  command = plan

  # --- the topic ---------------------------------------------------------------

  assert {
    condition = (
      aws_sns_topic.ops_alerts.name == "cmp-unit-ops-alerts" &&
      aws_sns_topic.ops_alerts.kms_master_key_id == "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001"
    )
    error_message = "the topic is <name_prefix>-ops-alerts, encrypted with the given key"
  }
  assert {
    condition = (
      keys(aws_sns_topic_subscription.email) == ["ops@example.com"] &&
      aws_sns_topic_subscription.email["ops@example.com"].protocol == "email" &&
      aws_sns_topic_subscription.email["ops@example.com"].endpoint == "ops@example.com" &&
      aws_sns_topic_subscription.email["ops@example.com"].topic_arn == aws_sns_topic.ops_alerts.arn
    )
    error_message = "each address is an email subscription of the topic"
  }

  # --- every alarm ---------------------------------------------------------------

  assert {
    condition = toset([for alarm in aws_cloudwatch_metric_alarm.this : alarm.alarm_name]) == toset([
      "cmp-unit-web-below-task-floor",
      "cmp-unit-web-unhealthy-hosts",
      "cmp-unit-browser-proxy-unavailable",
      "cmp-unit-memory-capture-failures",
      "cmp-unit-chat-worker-no-running-tasks",
      "cmp-unit-memory-worker-no-running-tasks",
      "cmp-unit-web-5xx",
      "cmp-unit-load-balancer-5xx",
      "cmp-unit-run-failure-burst",
    ])
    error_message = "the nine single-metric alarms production has today exist, named <name_prefix>-<alarm>"
  }
  assert {
    condition = alltrue([
      for alarm in concat(values(aws_cloudwatch_metric_alarm.this), values(aws_cloudwatch_metric_alarm.bedrock_token_headroom)) :
      alarm.alarm_actions == toset([aws_sns_topic.ops_alerts.arn]) && alarm.ok_actions == toset([aws_sns_topic.ops_alerts.arn])
    ])
    error_message = "every alarm notifies the ops topic when it fires and when it clears: an alarm with no action is an alarm nobody receives"
  }
  assert {
    condition = alltrue([
      for alarm in aws_cloudwatch_metric_alarm.this : alarm.metric_name != "RunningTaskCount"
    ])
    error_message = "RunningTaskCount exists only with Container Insights; task alarms use LiveTaskCount"
  }

  # --- task counts ---------------------------------------------------------------

  assert {
    condition = alltrue([
      for name in ["web-below-task-floor", "browser-proxy-unavailable", "chat-worker-no-running-tasks", "memory-worker-no-running-tasks"] : (
        aws_cloudwatch_metric_alarm.this[name].namespace == "AWS/ECS" &&
        aws_cloudwatch_metric_alarm.this[name].metric_name == "LiveTaskCount" &&
        aws_cloudwatch_metric_alarm.this[name].statistic == "Minimum" &&
        aws_cloudwatch_metric_alarm.this[name].period == 60 &&
        aws_cloudwatch_metric_alarm.this[name].evaluation_periods == 3 &&
        aws_cloudwatch_metric_alarm.this[name].datapoints_to_alarm == 3 &&
        aws_cloudwatch_metric_alarm.this[name].comparison_operator == "LessThanThreshold" &&
        aws_cloudwatch_metric_alarm.this[name].treat_missing_data == "breaching"
      )
    ])
    error_message = "a task alarm fires on the minimum live task count of 3 of 3 one-minute periods, and on missing data"
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.this["web-below-task-floor"].dimensions == tomap({ ClusterName = "cmp-unit-cluster", ServiceName = "cmp-unit-web" }) &&
      aws_cloudwatch_metric_alarm.this["browser-proxy-unavailable"].dimensions == tomap({ ClusterName = "cmp-unit-cluster", ServiceName = "cmp-unit-browser-proxy" }) &&
      aws_cloudwatch_metric_alarm.this["chat-worker-no-running-tasks"].dimensions == tomap({ ClusterName = "cmp-unit-cluster", ServiceName = "cmp-unit-chat-worker" }) &&
      aws_cloudwatch_metric_alarm.this["memory-worker-no-running-tasks"].dimensions == tomap({ ClusterName = "cmp-unit-cluster", ServiceName = "cmp-unit-memory-worker" })
    )
    error_message = "each task alarm watches its own service in the cluster"
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.this["web-below-task-floor"].threshold == var.web_min
    error_message = "the web floor alarm's threshold is the autoscaling minimum, so the two cannot drift apart"
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.this["browser-proxy-unavailable"].threshold == 1 &&
      aws_cloudwatch_metric_alarm.this["chat-worker-no-running-tasks"].threshold == 1 &&
      aws_cloudwatch_metric_alarm.this["memory-worker-no-running-tasks"].threshold == 1
    )
    error_message = "the proxy and the workers alarm below one live task"
  }

  # --- load balancer ---------------------------------------------------------------

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.this["web-unhealthy-hosts"].namespace == "AWS/ApplicationELB" &&
      aws_cloudwatch_metric_alarm.this["web-unhealthy-hosts"].metric_name == "UnHealthyHostCount" &&
      aws_cloudwatch_metric_alarm.this["web-unhealthy-hosts"].statistic == "Maximum" &&
      aws_cloudwatch_metric_alarm.this["web-unhealthy-hosts"].period == 60 &&
      aws_cloudwatch_metric_alarm.this["web-unhealthy-hosts"].evaluation_periods == 3 &&
      aws_cloudwatch_metric_alarm.this["web-unhealthy-hosts"].datapoints_to_alarm == 3 &&
      aws_cloudwatch_metric_alarm.this["web-unhealthy-hosts"].threshold == 1 &&
      aws_cloudwatch_metric_alarm.this["web-unhealthy-hosts"].comparison_operator == "GreaterThanOrEqualToThreshold" &&
      aws_cloudwatch_metric_alarm.this["web-unhealthy-hosts"].treat_missing_data == "notBreaching" &&
      aws_cloudwatch_metric_alarm.this["web-unhealthy-hosts"].dimensions == tomap({
        LoadBalancer = "app/cmp-unit-alb/0123456789abcdef", TargetGroup = "targetgroup/cmp-unit-web/fedcba9876543210"
      })
    )
    error_message = "unhealthy hosts: maximum of at least 1 for 3 of 3 minutes on the web target group"
  }
  assert {
    condition = alltrue([
      for name in ["web-5xx", "load-balancer-5xx"] : (
        aws_cloudwatch_metric_alarm.this[name].namespace == "AWS/ApplicationELB" &&
        aws_cloudwatch_metric_alarm.this[name].statistic == "Sum" &&
        aws_cloudwatch_metric_alarm.this[name].period == 300 &&
        aws_cloudwatch_metric_alarm.this[name].evaluation_periods == 1 &&
        aws_cloudwatch_metric_alarm.this[name].datapoints_to_alarm == null &&
        aws_cloudwatch_metric_alarm.this[name].threshold == 5 &&
        aws_cloudwatch_metric_alarm.this[name].comparison_operator == "GreaterThanOrEqualToThreshold" &&
        aws_cloudwatch_metric_alarm.this[name].treat_missing_data == "notBreaching"
      )
    ])
    error_message = "5xx: at least 5 in one 5-minute period"
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.this["web-5xx"].metric_name == "HTTPCode_Target_5XX_Count" &&
      aws_cloudwatch_metric_alarm.this["web-5xx"].dimensions == tomap({
        LoadBalancer = "app/cmp-unit-alb/0123456789abcdef", TargetGroup = "targetgroup/cmp-unit-web/fedcba9876543210"
      }) &&
      aws_cloudwatch_metric_alarm.this["load-balancer-5xx"].metric_name == "HTTPCode_ELB_5XX_Count" &&
      aws_cloudwatch_metric_alarm.this["load-balancer-5xx"].dimensions == tomap({ LoadBalancer = "app/cmp-unit-alb/0123456789abcdef" })
    )
    error_message = "target 5xx is counted on the web target group, load balancer 5xx on the load balancer"
  }

  # --- worker failures -------------------------------------------------------------

  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.memory_capture_failures.log_group_name == "/comparative/unit/memory-worker" &&
      aws_cloudwatch_log_metric_filter.memory_capture_failures.pattern == "?\"memory-capture-error\" ?\"memory-capture-worker-fatal\"" &&
      aws_cloudwatch_log_metric_filter.memory_capture_failures.metric_transformation[0].namespace == "Comparative/unit/Workers" &&
      aws_cloudwatch_log_metric_filter.memory_capture_failures.metric_transformation[0].name == "MemoryCaptureFailures" &&
      aws_cloudwatch_log_metric_filter.memory_capture_failures.metric_transformation[0].value == "1" &&
      aws_cloudwatch_log_metric_filter.memory_capture_failures.metric_transformation[0].default_value == "0"
    )
    error_message = "memory capture failures: either log marker on the memory worker's log group counts 1, and a period without one counts 0"
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.this["memory-capture-failures"].namespace == "Comparative/unit/Workers" &&
      aws_cloudwatch_metric_alarm.this["memory-capture-failures"].metric_name == "MemoryCaptureFailures" &&
      aws_cloudwatch_metric_alarm.this["memory-capture-failures"].statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.this["memory-capture-failures"].period == 1200 &&
      aws_cloudwatch_metric_alarm.this["memory-capture-failures"].evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.this["memory-capture-failures"].threshold == 1 &&
      aws_cloudwatch_metric_alarm.this["memory-capture-failures"].comparison_operator == "GreaterThanOrEqualToThreshold" &&
      aws_cloudwatch_metric_alarm.this["memory-capture-failures"].treat_missing_data == "notBreaching"
    )
    error_message = "memory capture failures: at least 1 in 20 minutes, on the metric the filter writes"
  }
  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.run_failed_events.name == "run-failed-events" &&
      aws_cloudwatch_log_metric_filter.run_failed_events.log_group_name == "/comparative/unit/chat-worker" &&
      aws_cloudwatch_log_metric_filter.run_failed_events.pattern == "\"[chat-run-worker-error]\"" &&
      aws_cloudwatch_log_metric_filter.run_failed_events.metric_transformation[0].namespace == "Comparative/unit/Workers" &&
      aws_cloudwatch_log_metric_filter.run_failed_events.metric_transformation[0].name == "RunFailedCount" &&
      aws_cloudwatch_log_metric_filter.run_failed_events.metric_transformation[0].value == "1" &&
      aws_cloudwatch_log_metric_filter.run_failed_events.metric_transformation[0].default_value == "0"
    )
    error_message = "run failures: the chat worker's error marker on its log group, not a run_failed event"
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.this["run-failure-burst"].namespace == "Comparative/unit/Workers" &&
      aws_cloudwatch_metric_alarm.this["run-failure-burst"].metric_name == "RunFailedCount" &&
      aws_cloudwatch_metric_alarm.this["run-failure-burst"].statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.this["run-failure-burst"].period == 900 &&
      aws_cloudwatch_metric_alarm.this["run-failure-burst"].evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.this["run-failure-burst"].threshold == 3 &&
      aws_cloudwatch_metric_alarm.this["run-failure-burst"].comparison_operator == "GreaterThanOrEqualToThreshold" &&
      aws_cloudwatch_metric_alarm.this["run-failure-burst"].treat_missing_data == "notBreaching"
    )
    error_message = "run failure burst: at least 3 in 15 minutes, on the metric the filter writes"
  }

  # --- Bedrock quota ---------------------------------------------------------------

  assert {
    condition     = keys(aws_cloudwatch_metric_alarm.bedrock_token_headroom) == ["us-anthropic-claude-sonnet-4-5-20250929-v1-0"]
    error_message = "one quota alarm per watched model, keyed by a name-safe form of its id"
  }
  assert {
    condition = alltrue([
      for alarm in aws_cloudwatch_metric_alarm.bedrock_token_headroom : (
        alarm.alarm_name == "cmp-unit-bedrock-us-anthropic-claude-sonnet-4-5-20250929-v1-0-token-headroom" &&
        alarm.threshold == 4320000 &&
        alarm.evaluation_periods == 1 &&
        alarm.comparison_operator == "GreaterThanOrEqualToThreshold" &&
        alarm.treat_missing_data == "notBreaching" &&
        strcontains(alarm.alarm_description, "Rolling 24-hour")
      )
    ])
    error_message = "quota: 80% of 5.4M tokens over a rolling 24 hours"
  }
  assert {
    condition = alltrue([
      for alarm in aws_cloudwatch_metric_alarm.bedrock_token_headroom : [
        for query in alarm.metric_query : [query.expression, query.return_data] if query.id == "quotaTokens"
        ] == [[
          "FILL(inputTokens, 0) + MAX([FILL(cacheWriteTokens, 0), FILL(cacheWriteTokenCount, 0)]) + (FILL(outputTokens, 0) * 5)",
          true,
      ]]
    ])
    error_message = "quota: input, plus cache writes under either spelling, plus 5 times output; the expression is what the alarm evaluates"
  }
  assert {
    condition = alltrue([
      for alarm in aws_cloudwatch_metric_alarm.bedrock_token_headroom : {
        for query in alarm.metric_query : query.id => join(" ", [
          query.metric[0].namespace, query.metric[0].metric_name, query.metric[0].dimensions["ModelId"],
          query.metric[0].stat, query.metric[0].period, coalesce(query.return_data, false),
        ]) if query.id != "quotaTokens"
        } == {
        inputTokens          = "AWS/Bedrock InputTokenCount us.anthropic.claude-sonnet-4-5-20250929-v1:0 Sum 86400 false"
        outputTokens         = "AWS/Bedrock OutputTokenCount us.anthropic.claude-sonnet-4-5-20250929-v1:0 Sum 86400 false"
        cacheWriteTokens     = "AWS/Bedrock CacheWriteInputTokens us.anthropic.claude-sonnet-4-5-20250929-v1:0 Sum 86400 false"
        cacheWriteTokenCount = "AWS/Bedrock CacheWriteInputTokenCount us.anthropic.claude-sonnet-4-5-20250929-v1:0 Sum 86400 false"
      }
    ])
    error_message = "quota: the four token metrics of the model, each a one-day sum that is not itself alarmed on"
  }

  # --- dashboard -------------------------------------------------------------------

  assert {
    condition     = aws_cloudwatch_dashboard.ops.dashboard_name == "cmp-unit-ops"
    error_message = "the dashboard is <name_prefix>-ops"
  }
  assert {
    condition = [for widget in jsondecode(aws_cloudwatch_dashboard.ops.dashboard_body).widgets : widget.properties.title] == [
      "ECS live tasks", "HTTP 5xx", "Worker failures", "Unhealthy web hosts",
      "Bedrock quota-weighted tokens per day: us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    ]
    error_message = "one widget per group of alarms and one per watched model"
  }
  assert {
    condition = toset(flatten([
      for widget in jsondecode(aws_cloudwatch_dashboard.ops.dashboard_body).widgets : [
        for metric in widget.properties.metrics : "${metric[0]} ${metric[1]} ${metric[length(metric) - 1].label}"
      ] if !startswith(widget.properties.title, "Bedrock")
      ])) == toset([
      for name, alarm in aws_cloudwatch_metric_alarm.this : "${alarm.namespace} ${alarm.metric_name} ${name}"
    ])
    error_message = "the dashboard shows the metric of every alarm"
  }
  assert {
    condition = alltrue([
      for widget in jsondecode(aws_cloudwatch_dashboard.ops.dashboard_body).widgets : (
        widget.properties.metrics[0][0].expression == "FILL(inputTokens, 0) + MAX([FILL(cacheWriteTokens, 0), FILL(cacheWriteTokenCount, 0)]) + (FILL(outputTokens, 0) * 5)" &&
        widget.properties.annotations.horizontal[0].value == 4320000 &&
        widget.properties.period == 86400 && widget.properties.stat == "Sum"
      ) if startswith(widget.properties.title, "Bedrock")
    ])
    error_message = "the quota widget plots the alarm's expression against the alarm's threshold"
  }
}

# A smaller environment with two watched models, as personal-stage is.
run "another_environment" {
  command = plan

  variables {
    env         = "other"
    name_prefix = "cmp-other"
    web_min     = 1
    quota_alarm_models = [
      { model_id = "vendor.model-a-v1:0", daily_quota = 1000000, output_burndown = 5 },
      { model_id = "us.vendor.model-b", daily_quota = 2000000, output_burndown = 1 },
    ]
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.this["web-below-task-floor"].threshold == 1
    error_message = "the web floor follows web_min"
  }
  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.run_failed_events.metric_transformation[0].namespace == "Comparative/other/Workers" &&
      aws_cloudwatch_metric_alarm.this["run-failure-burst"].namespace == "Comparative/other/Workers" &&
      aws_cloudwatch_metric_alarm.this["memory-capture-failures"].namespace == "Comparative/other/Workers"
    )
    error_message = "log-derived metrics carry the environment, so two environments of one account do not count each other's failures"
  }
  assert {
    condition = { for key, alarm in aws_cloudwatch_metric_alarm.bedrock_token_headroom : key => alarm.threshold } == {
      "vendor-model-a-v1-0" = 800000
      "us-vendor-model-b"   = 1600000
    }
    error_message = "each watched model alarms at 80% of its own quota"
  }
  assert {
    condition = alltrue([
      for query in aws_cloudwatch_metric_alarm.bedrock_token_headroom["us-vendor-model-b"].metric_query :
      endswith(query.expression, "(FILL(outputTokens, 0) * 1)") if query.id == "quotaTokens"
    ])
    error_message = "the output burndown is the model's own"
  }
}

run "no_watched_model" {
  command = plan

  variables {
    quota_alarm_models = []
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.bedrock_token_headroom) == 0 && length(aws_cloudwatch_metric_alarm.this) == 9
    error_message = "an environment that watches no quota still has the nine other alarms"
  }
}

run "an_address_listed_twice_is_one_subscription" {
  command = plan

  variables {
    alert_emails = ["ops@example.com", "second@example.com", "ops@example.com"]
  }

  assert {
    condition     = keys(aws_sns_topic_subscription.email) == ["ops@example.com", "second@example.com"]
    error_message = "one subscription per distinct address"
  }
}

run "no_address_is_rejected" {
  command = plan

  variables {
    alert_emails = []
  }

  expect_failures = [var.alert_emails]
}
