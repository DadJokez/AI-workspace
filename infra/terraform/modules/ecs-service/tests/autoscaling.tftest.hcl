# Autoscaling, tested by applying against a mocked AWS provider: no
# credentials, no AWS calls. Whether a later plan leaves the running count
# alone can only be seen with a state, so the first run applies and the second
# plans against what it left. (override_during = plan, which the plan-only
# tests use, cannot be combined with an apply.)

mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }

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

run "autoscaled_service" {
  command = apply

  variables {
    desired_count = 9
    autoscaling = {
      min        = 2
      max        = 4
      cpu_target = 60
    }
  }

  assert {
    condition     = length(aws_ecs_service.autoscaled) == 1 && length(aws_ecs_service.fixed) == 0
    error_message = "with autoscaling there is one service, whose count autoscaling owns"
  }
  assert {
    condition     = aws_ecs_service.autoscaled[0].desired_count == 2
    error_message = "an autoscaled service starts at its floor, not at desired_count"
  }
  assert {
    condition = (
      aws_ecs_service.autoscaled[0].network_configuration[0].assign_public_ip == false &&
      aws_ecs_service.autoscaled[0].deployment_circuit_breaker[0].enable == true &&
      aws_ecs_service.autoscaled[0].deployment_circuit_breaker[0].rollback == true &&
      aws_ecs_service.autoscaled[0].wait_for_steady_state == true &&
      aws_ecs_service.autoscaled[0].enable_execute_command == false
    )
    error_message = "an autoscaled service keeps every guarantee of a fixed one"
  }
  assert {
    condition = (
      aws_appautoscaling_target.this[0].service_namespace == "ecs" &&
      aws_appautoscaling_target.this[0].scalable_dimension == "ecs:service:DesiredCount" &&
      aws_appautoscaling_target.this[0].resource_id == "service/cmp-unit-cluster/cmp-unit-web" &&
      aws_appautoscaling_target.this[0].min_capacity == 2 &&
      aws_appautoscaling_target.this[0].max_capacity == 4
    )
    error_message = "autoscaling targets the service's task count between min and max"
  }
  assert {
    condition = (
      aws_appautoscaling_policy.cpu[0].policy_type == "TargetTrackingScaling" &&
      aws_appautoscaling_policy.cpu[0].target_tracking_scaling_policy_configuration[0].target_value == 60 &&
      aws_appautoscaling_policy.cpu[0].target_tracking_scaling_policy_configuration[0].scale_out_cooldown == 60 &&
      aws_appautoscaling_policy.cpu[0].target_tracking_scaling_policy_configuration[0].scale_in_cooldown == 300 &&
      aws_appautoscaling_policy.cpu[0].target_tracking_scaling_policy_configuration[0].predefined_metric_specification[0].predefined_metric_type == "ECSServiceAverageCPUUtilization"
    )
    error_message = "the policy tracks average CPU, scaling out after 60 s and in after 300 s"
  }
}

# The state now holds the service at 2 tasks. Raising the floor moves the
# autoscaling target and leaves the service's own count to autoscaling.
run "autoscaled_service_ignores_desired_count" {
  command = plan

  variables {
    autoscaling = {
      min        = 3
      max        = 6
      cpu_target = 60
    }
  }

  assert {
    condition     = aws_appautoscaling_target.this[0].min_capacity == 3 && aws_appautoscaling_target.this[0].max_capacity == 6
    error_message = "the autoscaling target follows the variables"
  }
  assert {
    condition     = aws_ecs_service.autoscaled[0].desired_count == 2
    error_message = "a plan must not change the running count of an autoscaled service"
  }
}
