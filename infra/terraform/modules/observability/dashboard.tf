# One dashboard of what the alarms watch. The widgets are built from the alarm
# definitions in main.tf, so a metric cannot be alarmed on without being shown
# here, statistic and period included.

locals {
  widget_titles = distinct([for alarm in values(local.alarms) : alarm.widget])

  alarm_widgets = [
    for title in local.widget_titles : {
      type   = "metric"
      width  = 12
      height = 6
      properties = {
        title  = title
        region = var.aws_region
        view   = "timeSeries"
        metrics = [
          for name, alarm in local.alarms : concat(
            [alarm.namespace, alarm.metric_name],
            flatten([for key, value in alarm.dimensions : [key, value]]),
            [{ label = name, stat = alarm.statistic, period = alarm.period }],
          ) if alarm.widget == title
        ]
      }
    }
  ]

  quota_widgets = [
    for name, model in local.quota_models : {
      type   = "metric"
      width  = 12
      height = 6
      properties = {
        title  = "Bedrock quota-weighted tokens per day: ${model.model_id}"
        region = var.aws_region
        view   = "timeSeries"
        stat   = "Sum"
        period = 86400
        metrics = concat(
          [[{ id = "quotaTokens", expression = model.expression, label = "Quota-weighted tokens" }]],
          [
            for id, metric_name in local.bedrock_token_metrics :
            ["AWS/Bedrock", metric_name, "ModelId", model.model_id, { id = id, visible = false }]
          ],
        )
        annotations = {
          horizontal = [{ label = "80% of the daily quota", value = model.threshold }]
        }
      }
    }
  ]
}

resource "aws_cloudwatch_dashboard" "ops" {
  dashboard_name = "${var.name_prefix}-ops"
  dashboard_body = jsonencode({ widgets = concat(local.alarm_widgets, local.quota_widgets) })
}
