# One Fargate task definition with its log group, execution role and task role.
# modules/ecs-service wraps it in a service; 35-deploy-tasks uses it alone for
# the tasks the pipeline runs once per release.
#
# Policies are written with jsonencode from inputs, so every document is known
# at plan time: `terraform test` can assert on it and the Conftest rules can
# read it in the plan JSON.

data "aws_partition" "current" {}

locals {
  family = "${var.name_prefix}-${var.name}"

  # <account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<digest>.
  # An image the validation of var.image rejects yields no parts, so that the
  # validation message is the only error.
  image_parts = try(
    regex("^(?P<account>[0-9]+)\\.dkr\\.ecr\\.(?P<region>[a-z0-9-]+)\\.[a-z.]+/(?P<repository>[^@]+)@", var.image),
    { account = "", region = "", repository = "" },
  )
  repository_arn = join(":", [
    "arn", data.aws_partition.current.partition, "ecr", local.image_parts.region, local.image_parts.account,
    "repository/${local.image_parts.repository}",
  ])

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  # Keys with no value are left out: ECS would store them as empty and the
  # next plan would show a difference.
  container = merge(
    {
      name      = var.name
      image     = var.image
      essential = true

      # Maps iterate in key order, so both lists are stable.
      environment = [for name, value in var.environment : { name = name, value = value }]
      secrets     = [for name, value_from in var.secrets : { name = name, valueFrom = value_from }]

      portMappings = var.port == null ? [] : [
        { containerPort = var.port, hostPort = var.port, protocol = "tcp" },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = var.name
        }
      }
    },
    var.command == null ? {} : { command = var.command },
    var.health_check == null ? {} : {
      healthCheck = {
        command     = var.health_check.command
        interval    = var.health_check.interval
        timeout     = var.health_check.timeout
        retries     = var.health_check.retries
        startPeriod = var.health_check.start_period
      }
    },
  )
}

resource "aws_cloudwatch_log_group" "this" {
  name              = var.log_group_name
  retention_in_days = 30
  kms_key_id        = var.kms_logs_arn
}

# --- execution role: what ECS needs to start the task ---------------------------

resource "aws_iam_role" "execution" {
  name                 = "${local.family}-execution"
  path                 = "/comparative/${var.env}/"
  permissions_boundary = var.permissions_boundary_arn
  assume_role_policy   = local.assume_role_policy
}

resource "aws_iam_role_policy" "execution" {
  name = "start-task"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          # ecr:GetAuthorizationToken does not support resource-level permissions.
          Sid      = "RegistryLogin"
          Effect   = "Allow"
          Action   = "ecr:GetAuthorizationToken"
          Resource = "*"
        },
        {
          Sid      = "PullImage"
          Effect   = "Allow"
          Action   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
          Resource = local.repository_arn
        },
        {
          Sid      = "WriteLogs"
          Effect   = "Allow"
          Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
          Resource = "${aws_cloudwatch_log_group.this.arn}:*"
        },
      ],
      # Only for a task that has secrets.
      [for statement in [
        {
          Sid      = "ReadTaskSecrets"
          Effect   = "Allow"
          Action   = "secretsmanager:GetSecretValue"
          Resource = var.execution_secret_arns
        },
        {
          Sid      = "DecryptTaskSecrets"
          Effect   = "Allow"
          Action   = "kms:Decrypt"
          Resource = var.kms_secrets_arn
          Condition = {
            StringEquals = { "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com" }
          }
        },
      ] : statement if length(var.execution_secret_arns) > 0],
    )
  })
}

# --- task role: what the application itself may call -----------------------------

resource "aws_iam_role" "task" {
  name                 = "${local.family}-task"
  path                 = "/comparative/${var.env}/"
  permissions_boundary = var.permissions_boundary_arn
  assume_role_policy   = local.assume_role_policy
}

resource "aws_iam_role_policy" "task" {
  count = var.task_policy_json == null ? 0 : 1

  name   = "workload"
  role   = aws_iam_role.task.id
  policy = var.task_policy_json
}

# --- task definition ------------------------------------------------------------

resource "aws_ecs_task_definition" "this" {
  family                   = local.family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([local.container])

  # A release registers the new revision first and deregisters the old one
  # only after the service has moved to the new one, so a deployment that the
  # circuit breaker rolls back still finds the revision it returns to.
  lifecycle {
    create_before_destroy = true
  }
}
