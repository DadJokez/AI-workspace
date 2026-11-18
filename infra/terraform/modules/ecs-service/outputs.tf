output "service_name" {
  description = "Name of the ECS service."
  value       = one(concat(aws_ecs_service.fixed[*].name, aws_ecs_service.autoscaled[*].name))
}
