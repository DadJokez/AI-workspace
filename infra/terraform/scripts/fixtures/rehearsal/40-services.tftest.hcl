# rehearsal.sh --plan-only: 40-services of personal-rehearsal against a mocked
# AWS provider. What the earlier stacks and 50-agentcore publish is supplied
# here, the stand-in proxy included; the variables come from
# envs/personal-rehearsal/env.tfvars and plan-only.tfvars.

mock_provider "aws" {
  override_during = plan

  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111122223333"
    }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:111122223333:log-group:/comparative/personal-rehearsal/mock"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111122223333:role/comparative/personal-rehearsal/mock"
    }
  }

  mock_resource "aws_ecs_task_definition" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:111122223333:task-definition/cmp-personal-rehearsal-mock:1"
    }
  }

  mock_resource "aws_service_discovery_service" {
    defaults = {
      arn = "arn:aws:servicediscovery:us-east-1:111122223333:service/srv-0123456789abcdef"
    }
  }
}

# --- 00-foundation ---------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.logs_kms_key_arn
  values = { insecure_value = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000003" }
}

override_data {
  target = data.aws_ssm_parameter.secrets_kms_key_arn
  values = { insecure_value = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000002" }
}

override_data {
  target = data.aws_ssm_parameter.workload_boundary_arn
  values = { insecure_value = "arn:aws:iam::111122223333:policy/cmp-personal-rehearsal-workload-boundary" }
}

# --- 10-network -------------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.app_subnet_ids
  values = { insecure_value = "[\"subnet-0aaaaaaaaaaaaaaaa\",\"subnet-0bbbbbbbbbbbbbbbb\"]" }
}

override_data {
  target = data.aws_ssm_parameter.web_security_group_id
  values = { insecure_value = "sg-0000000000000web1" }
}

override_data {
  target = data.aws_ssm_parameter.worker_security_group_id
  values = { insecure_value = "sg-0000000000worker1" }
}

override_data {
  target = data.aws_ssm_parameter.browser_proxy_security_group_id
  values = { insecure_value = "sg-00000000000proxy1" }
}

override_data {
  target = data.aws_ssm_parameter.proxy_url
  values = { insecure_value = "http://proxy.cmp-personal-rehearsal-egress.internal:3128" }
}

override_data {
  target = data.aws_ssm_parameter.no_proxy
  values = { insecure_value = "bedrock-runtime.us-east-1.amazonaws.com,bedrock-agentcore.us-east-1.amazonaws.com,secretsmanager.us-east-1.amazonaws.com,logs.us-east-1.amazonaws.com,s3.us-east-1.amazonaws.com,.s3.us-east-1.amazonaws.com,.us-east-1.elb.amazonaws.com,169.254.170.2,localhost,127.0.0.1,10.65.0.2" }
}

# --- 20-data ----------------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.app_secret_arn
  values = { insecure_value = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/personal-rehearsal/app-AbCdEf" }
}

override_data {
  target = data.aws_ssm_parameter.browser_proxy_secret_arn
  values = { insecure_value = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/personal-rehearsal/browser-proxy-GhIjKl" }
}

override_data {
  target = data.aws_ssm_parameter.browser_proxy_db_secret_arn
  values = { insecure_value = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/personal-rehearsal/browser-proxy-db-MnOpQr" }
}

# --- 30-platform ------------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.cluster_arn
  values = { insecure_value = "arn:aws:ecs:us-east-1:111122223333:cluster/cmp-personal-rehearsal-cluster" }
}

override_data {
  target = data.aws_ssm_parameter.namespace_id
  values = { insecure_value = "ns-0123456789abcdef" }
}

override_data {
  target = data.aws_ssm_parameter.web_target_group_arn
  values = { insecure_value = "arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/cmp-personal-rehearsal-web/0123456789abcdef" }
}

override_data {
  target = data.aws_ssm_parameter.base_url
  values = { insecure_value = "https://rehearsal.example.com" }
}

# --- 50-agentcore -----------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.runtime_arn
  values = { insecure_value = "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/cmp_personal_rehearsal_agent-AbCdEfGhIj" }
}

override_data {
  target = data.aws_ssm_parameter.browser_id
  values = { insecure_value = "cmp_personal_rehearsal_studio_browser-AbCdEfGhIj" }
}

override_data {
  target = data.aws_ssm_parameter.browser_arn
  values = { insecure_value = "arn:aws:bedrock-agentcore:us-east-1:111122223333:browser-custom/cmp_personal_rehearsal_studio_browser-AbCdEfGhIj" }
}

run "rehearsal" {
  command = plan
}
