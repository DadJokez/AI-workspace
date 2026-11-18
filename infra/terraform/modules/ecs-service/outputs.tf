output "service_name" {
  description = "Name of the ECS service."
  value       = one(concat(aws_ecs_service.fixed[*].name, aws_ecs_service.autoscaled[*].name))
}

output "log_group_name" {
  description = "Name of the service's log group."
  value       = module.task.log_group_name
}
