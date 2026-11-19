# rehearsal.sh --plan-only: 35-deploy-tasks of personal-rehearsal against a
# mocked AWS provider. What the earlier stacks publish is supplied here; the
# variables come from envs/personal-rehearsal/env.tfvars and plan-only.tfvars.

mock_provider "aws" {
  override_during = plan

  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
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

# --- 20-data ----------------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.app_secret_arn
  values = { insecure_value = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/personal-rehearsal/app-AbCdEf" }
}

# --- 30-platform ------------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.base_url
  values = { insecure_value = "https://rehearsal.example.com" }
}

run "rehearsal" {
  command = plan
}
