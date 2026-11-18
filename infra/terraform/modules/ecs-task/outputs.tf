output "task_definition_arn" {
  description = "ARN of the task definition, with its revision."
  value       = aws_ecs_task_definition.this.arn
}

output "log_group_name" {
  description = "Name of the task's log group."
  value       = aws_cloudwatch_log_group.this.name
}
