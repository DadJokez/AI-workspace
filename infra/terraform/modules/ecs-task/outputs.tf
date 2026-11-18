output "task_definition_arn" {
  description = "ARN of the task definition, with its revision."
  value       = aws_ecs_task_definition.this.arn
}
