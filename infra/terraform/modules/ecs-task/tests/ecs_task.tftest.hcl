# Plan-only tests with a mocked AWS provider: no credentials, no AWS calls.

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
      arn = "arn:aws:logs:us-east-1:111122223333:log-group:/comparative/unit/migrator"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111122223333:role/comparative/unit/mock"
    }
  }
}

variables {
  env         = "unit"
  name_prefix = "cmp-unit"
  aws_region  = "us-east-1"
  name        = "migrator"

  image  = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-app@sha256:0000000000000000000000000000000000000000000000000000000000000001"
  cpu    = 256
  memory = 512

  secrets = {
    DATABASE_URL = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/app-AbCdEf:DATABASE_URL::"
  }
  execution_secret_arns = ["arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/app-AbCdEf"]

  log_group_name           = "/comparative/unit/migrator"
  kms_logs_arn             = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001"
  kms_secrets_arn          = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000002"
  permissions_boundary_arn = "arn:aws:iam::111122223333:policy/cmp-unit-workload-boundary"
}

# --- the image ------------------------------------------------------------------

run "image_by_tag_is_rejected" {
  command = plan

  variables {
    image = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-app:migrator-latest"
  }

  expect_failures = [var.image]
}

run "image_by_tag_and_digest_is_rejected" {
  command = plan

  variables {
    image = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-app:migrator-1@sha256:0000000000000000000000000000000000000000000000000000000000000001"
  }

  expect_failures = [var.image]
}

run "image_with_a_short_digest_is_rejected" {
  command = plan

  variables {
    image = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-app@sha256:abc123"
  }

  expect_failures = [var.image]
}

# --- the task -------------------------------------------------------------------

run "task_definition" {
  command = plan

  assert {
    condition = (
      aws_ecs_task_definition.this.family == "cmp-unit-migrator" &&
      aws_ecs_task_definition.this.network_mode == "awsvpc" &&
      contains(aws_ecs_task_definition.this.requires_compatibilities, "FARGATE") &&
      aws_ecs_task_definition.this.cpu == "256" &&
      aws_ecs_task_definition.this.memory == "512"
    )
    error_message = "the task is a Fargate task of the given size, named <name_prefix>-<name>"
  }
  assert {
    condition     = aws_ecs_task_definition.this.runtime_platform[0].cpu_architecture == "X86_64"
    error_message = "the default architecture is X86_64"
  }
  assert {
    condition     = length(jsondecode(aws_ecs_task_definition.this.container_definitions)) == 1
    error_message = "the task has exactly one container"
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].image == var.image
    error_message = "the container runs the image it was given, by digest"
  }
  assert {
    condition     = !contains(keys(jsondecode(aws_ecs_task_definition.this.container_definitions)[0]), "command")
    error_message = "without a command the image's own runs"
  }
  assert {
    condition = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].secrets == [
      { name = "DATABASE_URL", valueFrom = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/app-AbCdEf:DATABASE_URL::" },
    ]
    error_message = "a secret reaches the container as a valueFrom reference"
  }
  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.this.container_definitions)[0].logConfiguration.options["awslogs-group"] == "/comparative/unit/migrator"
    )
    error_message = "the container logs to the task's log group"
  }
}

run "log_group" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_log_group.this.name == "/comparative/unit/migrator" &&
      aws_cloudwatch_log_group.this.retention_in_days == 30 &&
      aws_cloudwatch_log_group.this.kms_key_id == var.kms_logs_arn
    )
    error_message = "logs are kept 30 days, encrypted with the logs key"
  }
}

# --- the roles ------------------------------------------------------------------

run "roles" {
  command = plan

  assert {
    condition = alltrue([
      for role in [aws_iam_role.execution, aws_iam_role.task] :
      role.path == "/comparative/unit/" && role.permissions_boundary == var.permissions_boundary_arn
    ])
    error_message = "both roles live under /comparative/<env>/ and carry the workload boundary"
  }
  assert {
    condition = (
      aws_iam_role.execution.name == "cmp-unit-migrator-execution" &&
      aws_iam_role.task.name == "cmp-unit-migrator-task"
    )
    error_message = "the execution role and the task role are two roles"
  }
  assert {
    condition = alltrue([
      for role in [aws_iam_role.execution, aws_iam_role.task] :
      jsondecode(role.assume_role_policy).Statement[0].Principal.Service == "ecs-tasks.amazonaws.com"
    ])
    error_message = "only ECS tasks may assume the roles"
  }
  assert {
    condition = one([
      for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s.Resource if s.Sid == "PullImage"
    ]) == "arn:aws:ecr:us-east-1:111122223333:repository/cmp-unit-app"
    error_message = "the execution role pulls from the image's repository only"
  }
  assert {
    condition = tolist(one([
      for s in jsondecode(aws_iam_role_policy.execution.policy).Statement : s.Resource if s.Sid == "ReadTaskSecrets"
    ])) == var.execution_secret_arns
    error_message = "the execution role reads exactly the listed secrets"
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.execution.policy).Statement :
      s.Resource != "*" || s.Sid == "RegistryLogin"
    ])
    error_message = "only the registry login, which has no resource-level permission, is on \"*\""
  }
  assert {
    condition     = length(aws_iam_role_policy.task) == 0
    error_message = "without a task policy the task role has no permissions"
  }
}

run "task_without_secrets_reads_none" {
  command = plan

  variables {
    secrets               = {}
    execution_secret_arns = []
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.execution.policy).Statement :
      !contains(["ReadTaskSecrets", "DecryptTaskSecrets"], s.Sid)
    ])
    error_message = "a task without secrets gets no secret or key permission"
  }
}

run "command_health_check_port_and_policy" {
  command = plan

  variables {
    command = ["pnpm", "run", "thing"]
    port    = 3128
    health_check = {
      command      = ["CMD-SHELL", "true"]
      interval     = 30
      timeout      = 5
      retries      = 3
      start_period = 15
    }
    task_policy_json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ses:SendEmail\",\"Resource\":\"arn:aws:ses:us-east-1:111122223333:identity/example.com\"}]}"
    cpu_architecture = "ARM64"
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].command == ["pnpm", "run", "thing"]
    error_message = "the command is passed to the container"
  }
  assert {
    condition = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].portMappings == [
      { containerPort = 3128, hostPort = 3128, protocol = "tcp" },
    ]
    error_message = "the port is mapped"
  }
  assert {
    condition = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].healthCheck == {
      command     = ["CMD-SHELL", "true"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 15
    }
    error_message = "the health check is passed to the container"
  }
  assert {
    condition     = aws_iam_role_policy.task[0].policy == var.task_policy_json && aws_iam_role_policy.task[0].role == aws_iam_role.task.id
    error_message = "the supplied policy is the task role's policy"
  }
  assert {
    condition     = aws_ecs_task_definition.this.runtime_platform[0].cpu_architecture == "ARM64"
    error_message = "the architecture comes from the variable"
  }
}
