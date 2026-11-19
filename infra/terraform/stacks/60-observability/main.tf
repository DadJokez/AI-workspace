# 60-observability: the ops alert topic, the alarms, the log metric filters
# behind two of them and the dashboard of one environment.
#
# Applied last: it reads the cluster and the load balancer from 30-platform and
# the services and their log groups from 40-services.

# ARNs and names, not secrets: insecure_value keeps them readable in the plan.

# 00-foundation
data "aws_ssm_parameter" "logs_kms_key_arn" {
  name = "/comparative/${var.env}/00-foundation/kms/logs_arn"
}

data "aws_ssm_parameter" "break_glass_rule_arn" {
  name = "/comparative/${var.env}/00-foundation/events/break_glass_rule_arn"
}

# 30-platform
data "aws_ssm_parameter" "cluster_name" {
  name = "/comparative/${var.env}/30-platform/cluster_name"
}

data "aws_ssm_parameter" "alb_arn_suffix" {
  name = "/comparative/${var.env}/30-platform/alb_arn_suffix"
}

data "aws_ssm_parameter" "web_target_group_arn_suffix" {
  name = "/comparative/${var.env}/30-platform/tg/web_arn_suffix"
}

# 40-services
data "aws_ssm_parameter" "web_service_name" {
  name = "/comparative/${var.env}/40-services/service/web_name"
}

data "aws_ssm_parameter" "chat_worker_service_name" {
  name = "/comparative/${var.env}/40-services/service/chat_worker_name"
}

data "aws_ssm_parameter" "memory_worker_service_name" {
  name = "/comparative/${var.env}/40-services/service/memory_worker_name"
}

data "aws_ssm_parameter" "browser_proxy_service_name" {
  name = "/comparative/${var.env}/40-services/service/browser_proxy_name"
}

data "aws_ssm_parameter" "chat_worker_log_group_name" {
  name = "/comparative/${var.env}/40-services/log_group/chat_worker_name"
}

data "aws_ssm_parameter" "memory_worker_log_group_name" {
  name = "/comparative/${var.env}/40-services/log_group/memory_worker_name"
}

locals {
  parameters = {
    "sns/ops_topic_arn" = module.observability.ops_topic_arn
  }
}

module "observability" {
  source = "../../modules/observability"

  env         = var.env
  name_prefix = var.name_prefix
  aws_region  = var.aws_region

  # The logs key: its policy in 00-foundation lets CloudWatch alarms use it
  # for this topic.
  kms_key_arn  = data.aws_ssm_parameter.logs_kms_key_arn.insecure_value
  alert_emails = var.alert_emails
  # Every use of the break-glass role is reported to this topic.
  event_rule_arns = [data.aws_ssm_parameter.break_glass_rule_arn.insecure_value]

  cluster_name = data.aws_ssm_parameter.cluster_name.insecure_value
  service_names = {
    web           = data.aws_ssm_parameter.web_service_name.insecure_value
    chat_worker   = data.aws_ssm_parameter.chat_worker_service_name.insecure_value
    memory_worker = data.aws_ssm_parameter.memory_worker_service_name.insecure_value
    browser_proxy = data.aws_ssm_parameter.browser_proxy_service_name.insecure_value
  }
  alb_arn_suffix               = data.aws_ssm_parameter.alb_arn_suffix.insecure_value
  web_target_group_arn_suffix  = data.aws_ssm_parameter.web_target_group_arn_suffix.insecure_value
  chat_worker_log_group_name   = data.aws_ssm_parameter.chat_worker_log_group_name.insecure_value
  memory_worker_log_group_name = data.aws_ssm_parameter.memory_worker_log_group_name.insecure_value

  web_min            = var.web_min
  quota_alarm_models = var.quota_alarm_models
}

# --- Published outputs -------------------------------------------------------

# Other stacks and the pipeline read this with an aws_ssm_parameter data
# source; there is no terraform_remote_state. An ARN, not a secret.
resource "aws_ssm_parameter" "published" {
  #checkov:skip=CKV2_AWS_34:An ARN, not a secret; plain String so any downstream stack can read it
  for_each = local.parameters

  name  = "/comparative/${var.env}/60-observability/${each.key}"
  type  = "String"
  value = each.value
}
