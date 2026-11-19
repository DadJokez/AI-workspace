# data_disposable turns off deletion protection, the final snapshot and the
# secret recovery window. Only a rehearsal environment may set it.

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
      arn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/personal-stage/mock-AbCdEf"
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
  values = { insecure_value = "arn:aws:iam::111122223333:policy/cmp-personal-stage-workload-boundary" }
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

variables {
  name_prefix                   = "cmp-personal-stage"
  env                           = "personal-stage"
  aws_region                    = "us-east-1"
  account_id                    = "111122223333"
  db_engine_version             = "16"
  db_instance_class             = "db.t4g.micro"
  db_multi_az                   = false
  db_max_allocated_storage      = 21
  db_backup_days                = 1
  db_log_min_duration_statement = 1000
  db_name                       = "comparative"
  db_master_username            = "comparative"
  tags = {
    app           = "comparative"
    env           = "personal-stage"
    owner         = "test"
    "cost-center" = "test"
    "data-class"  = "test"
    "managed-by"  = "terraform"
    repo          = "test"
  }
}

run "refused_outside_a_rehearsal" {
  command = plan

  variables {
    data_disposable = true
  }

  expect_failures = [var.data_disposable]
}

run "allowed_in_a_rehearsal" {
  command = plan

  variables {
    name_prefix     = "cmp-personal-rehearsal"
    env             = "personal-rehearsal"
    data_disposable = true
    tags = {
      app           = "comparative"
      env           = "personal-rehearsal"
      owner         = "test"
      "cost-center" = "test"
      "data-class"  = "test"
      "managed-by"  = "terraform"
      repo          = "test"
    }
  }

  assert {
    condition     = var.data_disposable
    error_message = "a rehearsal environment may be disposable"
  }
}
