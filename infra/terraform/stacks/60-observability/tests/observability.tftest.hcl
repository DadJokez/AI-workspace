# Plan-only tests of the stack with a mocked AWS provider: no credentials, no
# state, no AWS calls. What the earlier stacks publish is supplied here.
#
# A test file can only assert on what the root module sees. What the module
# plans inside from these values is checked by observability.sh, which reads
# the plan this run produces; the alarm definitions themselves are tested in
# ../../modules/observability.

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

override_data {
  target = data.aws_ssm_parameter.logs_kms_key_arn
  values = { insecure_value = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001" }
}

override_data {
  target = data.aws_ssm_parameter.cluster_name
  values = { insecure_value = "cmp-unit-cluster" }
}

override_data {
  target = data.aws_ssm_parameter.alb_arn_suffix
  values = { insecure_value = "app/cmp-unit-alb/0123456789abcdef" }
}

override_data {
  target = data.aws_ssm_parameter.web_target_group_arn_suffix
  values = { insecure_value = "targetgroup/cmp-unit-web/fedcba9876543210" }
}

override_data {
  target = data.aws_ssm_parameter.web_service_name
  values = { insecure_value = "cmp-unit-web" }
}

override_data {
  target = data.aws_ssm_parameter.chat_worker_service_name
  values = { insecure_value = "cmp-unit-chat-worker" }
}

override_data {
  target = data.aws_ssm_parameter.memory_worker_service_name
  values = { insecure_value = "cmp-unit-memory-worker" }
}

override_data {
  target = data.aws_ssm_parameter.browser_proxy_service_name
  values = { insecure_value = "cmp-unit-browser-proxy" }
}

override_data {
  target = data.aws_ssm_parameter.chat_worker_log_group_name
  values = { insecure_value = "/comparative/unit/chat-worker" }
}

override_data {
  target = data.aws_ssm_parameter.memory_worker_log_group_name
  values = { insecure_value = "/comparative/unit/memory-worker" }
}

variables {
  env         = "unit"
  name_prefix = "cmp-unit"
  aws_region  = "us-east-1"
  account_id  = "111122223333"
  tags = {
    "app"         = "comparative"
    "env"         = "unit"
    "owner"       = "platform"
    "cost-center" = "none"
    "data-class"  = "internal"
    "managed-by"  = "terraform"
    "repo"        = "example-owner/example-repo"
  }

  alert_emails = ["ops@example.com"]
  web_min      = 2
  quota_alarm_models = [
    { model_id = "vendor.model-a-v1:0", daily_quota = 1000000, output_burndown = 5 },
  ]
}

run "sandbox" {
  command = plan

  assert {
    condition     = keys(aws_ssm_parameter.published) == ["sns/ops_topic_arn"]
    error_message = "the stack publishes the ops topic"
  }
  assert {
    condition = (
      aws_ssm_parameter.published["sns/ops_topic_arn"].name == "/comparative/unit/60-observability/sns/ops_topic_arn" &&
      aws_ssm_parameter.published["sns/ops_topic_arn"].value == module.observability.ops_topic_arn &&
      module.observability.ops_topic_arn == "arn:aws:sns:us-east-1:111122223333:cmp-unit-ops-alerts"
    )
    error_message = "the parameter lives under /comparative/<env>/60-observability/ and holds the topic's ARN"
  }
  # The names 00-foundation, 30-platform and 40-services publish under; their
  # own tests assert the same keys.
  assert {
    condition = (
      data.aws_ssm_parameter.logs_kms_key_arn.name == "/comparative/unit/00-foundation/kms/logs_arn" &&
      data.aws_ssm_parameter.cluster_name.name == "/comparative/unit/30-platform/cluster_name" &&
      data.aws_ssm_parameter.alb_arn_suffix.name == "/comparative/unit/30-platform/alb_arn_suffix" &&
      data.aws_ssm_parameter.web_target_group_arn_suffix.name == "/comparative/unit/30-platform/tg/web_arn_suffix" &&
      data.aws_ssm_parameter.web_service_name.name == "/comparative/unit/40-services/service/web_name" &&
      data.aws_ssm_parameter.chat_worker_service_name.name == "/comparative/unit/40-services/service/chat_worker_name" &&
      data.aws_ssm_parameter.memory_worker_service_name.name == "/comparative/unit/40-services/service/memory_worker_name" &&
      data.aws_ssm_parameter.browser_proxy_service_name.name == "/comparative/unit/40-services/service/browser_proxy_name" &&
      data.aws_ssm_parameter.chat_worker_log_group_name.name == "/comparative/unit/40-services/log_group/chat_worker_name" &&
      data.aws_ssm_parameter.memory_worker_log_group_name.name == "/comparative/unit/40-services/log_group/memory_worker_name"
    )
    error_message = "every input is read from the parameter its owning stack publishes"
  }
}
