# rehearsal.sh --plan-only: 50-agentcore of personal-rehearsal against a mocked
# AWS provider. What the earlier stacks publish is supplied here, the stand-in
# proxy included; the variables come from envs/personal-rehearsal/env.tfvars
# and plan-only.tfvars.

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

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111122223333:role/comparative/personal-rehearsal/mock"
    }
  }

  mock_resource "aws_bedrockagentcore_agent_runtime" {
    defaults = {
      agent_runtime_arn = "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/cmp_personal_rehearsal_agent-AbCdEfGhIj"
    }
  }

  mock_resource "aws_bedrockagentcore_browser" {
    defaults = {
      browser_id  = "cmp_personal_rehearsal_studio_browser-AbCdEfGhIj"
      browser_arn = "arn:aws:bedrock-agentcore:us-east-1:111122223333:browser-custom/cmp_personal_rehearsal_studio_browser-AbCdEfGhIj"
    }
  }
}

# --- 00-foundation ---------------------------------------------------------------

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
  target = data.aws_ssm_parameter.agentcore_subnet_ids
  values = { insecure_value = "[\"subnet-0aaaaaaaaaaaaaaaa\",\"subnet-0bbbbbbbbbbbbbbbb\"]" }
}

override_data {
  target = data.aws_ssm_parameter.agent_runtime_security_group_id
  values = { insecure_value = "sg-00000000000runtime" }
}

override_data {
  target = data.aws_ssm_parameter.studio_browser_security_group_id
  values = { insecure_value = "sg-00000000000browser" }
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

run "rehearsal" {
  command = plan
}
