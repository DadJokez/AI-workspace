# rehearsal.sh --plan-only: 20-data of personal-rehearsal against a mocked AWS
# provider. What 00-foundation and 10-network publish is supplied here; the
# variables come from envs/personal-rehearsal/env.tfvars and plan-only.tfvars.

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

  mock_resource "aws_secretsmanager_secret" {
    defaults = {
      arn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/personal-rehearsal/mock-AbCdEf"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {}
  }
}

# --- 00-foundation ---------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.data_kms_key_arn
  values = { insecure_value = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001" }
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
  target = data.aws_ssm_parameter.data_subnet_ids
  values = { insecure_value = "[\"subnet-0cccccccccccccccc\",\"subnet-0dddddddddddddddd\"]" }
}

override_data {
  target = data.aws_ssm_parameter.db_security_group_id
  values = { insecure_value = "sg-0000000000000db01" }
}

run "rehearsal" {
  command = plan
}
