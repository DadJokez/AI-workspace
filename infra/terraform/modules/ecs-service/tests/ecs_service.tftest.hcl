# Plan-only tests with a mocked AWS provider: no credentials, no AWS calls.
# Autoscaling is tested in autoscaling.tftest.hcl; the task itself (roles, log
# group, container) in ../ecs-task.

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
      arn = "arn:aws:logs:us-east-1:111122223333:log-group:/comparative/unit/web"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111122223333:role/comparative/unit/mock"
    }
  }

  mock_resource "aws_ecs_task_definition" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:111122223333:task-definition/cmp-unit-web:1"
    }
  }

  mock_resource "aws_service_discovery_service" {
    defaults = {
      arn = "arn:aws:servicediscovery:us-east-1:111122223333:service/srv-0123456789abcdef"
    }
  }
}

variables {
  env         = "unit"
  name_prefix = "cmp-unit"
  aws_region  = "us-east-1"
  name        = "web"
  cluster_arn = "arn:aws:ecs:us-east-1:111122223333:cluster/cmp-unit-cluster"

  image  = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-app@sha256:0000000000000000000000000000000000000000000000000000000000000001"
  cpu    = 512
  memory = 1024

  subnet_ids         = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
  security_group_ids = ["sg-0aaaaaaaaaaaaaaaa"]

  log_group_name           = "/comparative/unit/web"
  kms_logs_arn             = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001"
  kms_secrets_arn          = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000002"
  permissions_boundary_arn = "arn:aws:iam::111122223333:policy/cmp-unit-workload-boundary"
}

# --- the image ------------------------------------------------------------------

run "image_by_tag_is_rejected" {
  command = plan

  variables {
    image = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-app:web-latest"
  }

  expect_failures = [var.image]
}

run "image_from_another_registry_is_rejected" {
  command = plan

  variables {
    image = "docker.io/library/nginx@sha256:0000000000000000000000000000000000000000000000000000000000000001"
  }

  expect_failures = [var.image]
}

# --- a service with a fixed count -------------------------------------------------

run "fixed_count_service" {
  command = plan

  variables {
    desired_count       = 3
    min_healthy_percent = 0
  }

  assert {
    condition     = length(aws_ecs_service.fixed) == 1 && length(aws_ecs_service.autoscaled) == 0
    error_message = "without autoscaling there is one service, whose count Terraform owns"
  }
  assert {
    condition     = aws_ecs_service.fixed[0].name == "cmp-unit-web" && aws_ecs_service.fixed[0].cluster == var.cluster_arn
    error_message = "the service is <name_prefix>-<name> in the given cluster"
  }
  assert {
    condition     = aws_ecs_service.fixed[0].launch_type == "FARGATE"
    error_message = "the service runs on Fargate"
  }
  assert {
    condition     = aws_ecs_service.fixed[0].desired_count == 3
    error_message = "desired_count is the variable"
  }
  assert {
    condition = (
      aws_ecs_service.fixed[0].network_configuration[0].assign_public_ip == false &&
      aws_ecs_service.fixed[0].network_configuration[0].subnets == toset(var.subnet_ids) &&
      aws_ecs_service.fixed[0].network_configuration[0].security_groups == toset(var.security_group_ids)
    )
    error_message = "tasks get no public IP and sit in the given subnets and security groups"
  }
  assert {
    condition = (
      aws_ecs_service.fixed[0].deployment_circuit_breaker[0].enable == true &&
      aws_ecs_service.fixed[0].deployment_circuit_breaker[0].rollback == true
    )
    error_message = "a failed deployment is stopped and rolled back"
  }
  assert {
    condition = (
      aws_ecs_service.fixed[0].wait_for_steady_state == true &&
      aws_ecs_service.fixed[0].enable_execute_command == false &&
      aws_ecs_service.fixed[0].propagate_tags == "SERVICE"
    )
    error_message = "an apply waits for a steady service; ECS Exec is off; tasks carry the service's tags"
  }
  assert {
    condition = (
      aws_ecs_service.fixed[0].deployment_minimum_healthy_percent == 0 &&
      aws_ecs_service.fixed[0].deployment_maximum_percent == 200
    )
    error_message = "min_healthy_percent is the variable; a deployment may double the tasks"
  }
  assert {
    condition     = length(aws_ecs_service.fixed[0].load_balancer) == 0 && length(aws_ecs_service.fixed[0].service_registries) == 0
    error_message = "no load balancer and no Cloud Map name unless asked for"
  }
  assert {
    condition     = length(aws_appautoscaling_target.this) == 0 && length(aws_appautoscaling_policy.cpu) == 0
    error_message = "no autoscaling unless asked for"
  }
  assert {
    condition     = output.service_name == "cmp-unit-web"
    error_message = "the service name is an output"
  }
}

# --- load balancer and Cloud Map --------------------------------------------------

run "load_balancer" {
  command = plan

  variables {
    port = 3000
    load_balancer = {
      target_group_arn = "arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/cmp-unit-web/0123456789abcdef"
    }
  }

  assert {
    condition = (
      one(aws_ecs_service.fixed[0].load_balancer).target_group_arn == var.load_balancer.target_group_arn &&
      one(aws_ecs_service.fixed[0].load_balancer).container_name == "web" &&
      one(aws_ecs_service.fixed[0].load_balancer).container_port == 3000
    )
    error_message = "the container's port is registered with the target group"
  }
  assert {
    condition     = aws_ecs_service.fixed[0].health_check_grace_period_seconds == 60
    error_message = "a new task gets 60 seconds before load balancer health checks count"
  }
}

run "load_balancer_needs_a_port" {
  command = plan

  variables {
    load_balancer = {
      target_group_arn = "arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/cmp-unit-web/0123456789abcdef"
    }
  }

  expect_failures = [var.load_balancer]
}

run "service_registry" {
  command = plan

  variables {
    name = "browser-proxy"
    port = 3128
    service_registry = {
      namespace_id = "ns-0123456789abcdef"
      name         = "browser-proxy"
    }
  }

  assert {
    condition = (
      aws_service_discovery_service.this[0].name == "browser-proxy" &&
      aws_service_discovery_service.this[0].dns_config[0].namespace_id == "ns-0123456789abcdef" &&
      aws_service_discovery_service.this[0].dns_config[0].dns_records[0].type == "A"
    )
    error_message = "the service gets an A record <name>.<namespace>"
  }
  assert {
    condition     = one(aws_ecs_service.fixed[0].service_registries).registry_arn == aws_service_discovery_service.this[0].arn
    error_message = "the tasks are registered under that name"
  }
}
