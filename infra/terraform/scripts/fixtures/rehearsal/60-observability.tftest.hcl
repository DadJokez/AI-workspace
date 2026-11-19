# rehearsal.sh --plan-only: 60-observability of personal-rehearsal against a
# mocked AWS provider. What the earlier stacks publish is supplied here; the
# variables come from envs/personal-rehearsal/env.tfvars and plan-only.tfvars.

mock_provider "aws" {
  override_during = plan

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-east-1:111122223333:cmp-personal-rehearsal-ops-alerts"
    }
  }
}

# --- 00-foundation ---------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.logs_kms_key_arn
  values = { insecure_value = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000003" }
}

# --- 30-platform ------------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.cluster_name
  values = { insecure_value = "cmp-personal-rehearsal-cluster" }
}

override_data {
  target = data.aws_ssm_parameter.alb_arn_suffix
  values = { insecure_value = "app/cmp-personal-rehearsal-alb/0123456789abcdef" }
}

override_data {
  target = data.aws_ssm_parameter.web_target_group_arn_suffix
  values = { insecure_value = "targetgroup/cmp-personal-rehearsal-web/0123456789abcdef" }
}

# --- 40-services ------------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.web_service_name
  values = { insecure_value = "cmp-personal-rehearsal-web" }
}

override_data {
  target = data.aws_ssm_parameter.chat_worker_service_name
  values = { insecure_value = "cmp-personal-rehearsal-chat-worker" }
}

override_data {
  target = data.aws_ssm_parameter.memory_worker_service_name
  values = { insecure_value = "cmp-personal-rehearsal-memory-worker" }
}

override_data {
  target = data.aws_ssm_parameter.browser_proxy_service_name
  values = { insecure_value = "cmp-personal-rehearsal-browser-proxy" }
}

override_data {
  target = data.aws_ssm_parameter.chat_worker_log_group_name
  values = { insecure_value = "/comparative/personal-rehearsal/chat-worker" }
}

override_data {
  target = data.aws_ssm_parameter.memory_worker_log_group_name
  values = { insecure_value = "/comparative/personal-rehearsal/memory-worker" }
}

run "rehearsal" {
  command = plan
}
