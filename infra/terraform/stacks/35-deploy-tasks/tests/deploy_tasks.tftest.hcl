# Plan-only tests of the stack with a mocked AWS provider: no credentials, no
# state, no AWS calls. What the earlier stacks publish is supplied here.
#
# A test file can only assert on what the root module sees. What the two
# modules plan inside is checked by deploy_tasks.sh, which reads the plans
# these runs produce.

mock_provider "aws" {
  override_during = plan

  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }

  # Declaring a resource type here is what makes its computed attributes
  # available while planning.
  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:111122223333:log-group:/comparative/unit/mock"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111122223333:role/comparative/unit/mock"
    }
  }

  mock_resource "aws_ecs_task_definition" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:111122223333:task-definition/cmp-unit-mock:7"
    }
  }
}

override_data {
  target = data.aws_ssm_parameter.logs_kms_key_arn
  values = { insecure_value = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001" }
}

override_data {
  target = data.aws_ssm_parameter.secrets_kms_key_arn
  values = { insecure_value = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000002" }
}

override_data {
  target = data.aws_ssm_parameter.workload_boundary_arn
  values = { insecure_value = "arn:aws:iam::111122223333:policy/cmp-unit-workload-boundary" }
}

override_data {
  target = data.aws_ssm_parameter.app_secret_arn
  values = { insecure_value = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/app-AbCdEf" }
}

override_data {
  target = data.aws_ssm_parameter.base_url
  values = { insecure_value = "https://app.example.com" }
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

  release_id     = "0123456789abcdef0123456789abcdef01234567"
  image_migrator = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-app@sha256:00000000000000000000000000000000000000000000000000000000000000a1"
  image_worker   = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-app@sha256:00000000000000000000000000000000000000000000000000000000000000a2"

  snapshot_keep_days = 7
}

run "sandbox" {
  command = plan

  assert {
    condition     = toset(keys(aws_ssm_parameter.published)) == toset(["taskdef/migrator_arn", "taskdef/smoke_arn", "snapshot_keep_days"])
    error_message = "the stack publishes the two task definitions the pipeline runs and how long it keeps its snapshots"
  }
  assert {
    condition = alltrue([
      for key, parameter in aws_ssm_parameter.published : parameter.name == "/comparative/unit/35-deploy-tasks/${key}"
    ])
    error_message = "parameters live under /comparative/<env>/35-deploy-tasks/"
  }
  assert {
    condition = (
      aws_ssm_parameter.published["taskdef/migrator_arn"].value == module.migrator.task_definition_arn &&
      aws_ssm_parameter.published["taskdef/smoke_arn"].value == module.smoke.task_definition_arn
    )
    error_message = "each parameter holds its task definition's ARN, revision included"
  }
  assert {
    condition     = aws_ssm_parameter.published["snapshot_keep_days"].value == "7"
    error_message = "snapshot_keep_days is published as a whole number"
  }
}

# An environment whose application is reached at an internal address.
run "internal_base_url" {
  command = plan

  variables {
    internal_base_url = "https://internal.app.example.com"
  }
}

run "snapshot_keep_days_must_be_whole_days" {
  command = plan

  variables {
    snapshot_keep_days = 0.5
  }

  expect_failures = [var.snapshot_keep_days]
}
