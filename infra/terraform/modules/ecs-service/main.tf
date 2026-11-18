# One Fargate service: the task of modules/ecs-task, the service itself, and
# optionally a Cloud Map name and CPU target-tracking autoscaling.
#
# Tasks never get a public IP, a failed deployment rolls back, and an apply
# returns only when the service is steady.

locals {
  service_name = "${var.name_prefix}-${var.name}"
  # arn:<partition>:ecs:<region>:<account>:cluster/<name>
  cluster_name = element(split("/", var.cluster_arn), 1)
  autoscaled   = var.autoscaling != null
}

module "task" {
  source = "../ecs-task"

  env         = var.env
  name_prefix = var.name_prefix
  aws_region  = var.aws_region
  name        = var.name

  image            = var.image
  command          = var.command
  cpu              = var.cpu
  memory           = var.memory
  port             = var.port
  environment      = var.environment
  secrets          = var.secrets
  health_check     = var.health_check
  cpu_architecture = var.cpu_architecture

  execution_secret_arns    = var.execution_secret_arns
  task_policy_json         = var.task_policy_json
  log_group_name           = var.log_group_name
  kms_logs_arn             = var.kms_logs_arn
  kms_secrets_arn          = var.kms_secrets_arn
  permissions_boundary_arn = var.permissions_boundary_arn
}

# --- Cloud Map -------------------------------------------------------------------

resource "aws_service_discovery_service" "this" {
  count = var.service_registry == null ? 0 : 1

  name = var.service_registry.name

  dns_config {
    namespace_id   = var.service_registry.namespace_id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 60
    }
  }

  # ECS reports each task's health to Cloud Map, so a task that fails its
  # container health check leaves the name.
  health_check_custom_config {}
}

# --- the service ----------------------------------------------------------------

# Terraform cannot make `ignore_changes` conditional, so the service is written
# twice. The two blocks differ in two places only: desired_count, and the
# lifecycle block that leaves the running count to Application Auto Scaling.
# Keep every other argument identical.

resource "aws_ecs_service" "fixed" {
  count = local.autoscaled ? 0 : 1

  name            = local.service_name
  cluster         = var.cluster_arn
  task_definition = module.task.task_definition_arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = var.min_healthy_percent
  deployment_maximum_percent         = 200
  # Time for a new task to answer its first health check before the load
  # balancer's verdict counts against it.
  health_check_grace_period_seconds = var.load_balancer == null ? null : 60

  wait_for_steady_state  = true
  propagate_tags         = "SERVICE"
  enable_execute_command = false

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.load_balancer == null ? [] : [var.load_balancer]

    content {
      target_group_arn = load_balancer.value.target_group_arn
      container_name   = var.name
      container_port   = var.port
    }
  }

  dynamic "service_registries" {
    for_each = aws_service_discovery_service.this

    content {
      registry_arn = service_registries.value.arn
    }
  }
}

resource "aws_ecs_service" "autoscaled" {
  count = local.autoscaled ? 1 : 0

  name            = local.service_name
  cluster         = var.cluster_arn
  task_definition = module.task.task_definition_arn
  desired_count   = var.autoscaling.min
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = var.min_healthy_percent
  deployment_maximum_percent         = 200
  # Time for a new task to answer its first health check before the load
  # balancer's verdict counts against it.
  health_check_grace_period_seconds = var.load_balancer == null ? null : 60

  wait_for_steady_state  = true
  propagate_tags         = "SERVICE"
  enable_execute_command = false

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.load_balancer == null ? [] : [var.load_balancer]

    content {
      target_group_arn = load_balancer.value.target_group_arn
      container_name   = var.name
      container_port   = var.port
    }
  }

  dynamic "service_registries" {
    for_each = aws_service_discovery_service.this

    content {
      registry_arn = service_registries.value.arn
    }
  }

  # Application Auto Scaling owns the running count: a routine apply must not
  # scale a busy service back to its floor.
  lifecycle {
    ignore_changes = [desired_count]
  }
}

# --- autoscaling ----------------------------------------------------------------

resource "aws_appautoscaling_target" "this" {
  count = local.autoscaled ? 1 : 0

  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${local.cluster_name}/${local.service_name}"
  min_capacity       = var.autoscaling.min
  max_capacity       = var.autoscaling.max

  depends_on = [aws_ecs_service.autoscaled]
}

resource "aws_appautoscaling_policy" "cpu" {
  count = local.autoscaled ? 1 : 0

  name               = "${local.service_name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension
  resource_id        = aws_appautoscaling_target.this[0].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling.cpu_target
    scale_out_cooldown = var.autoscaling.scale_out_cooldown
    scale_in_cooldown  = var.autoscaling.scale_in_cooldown

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
