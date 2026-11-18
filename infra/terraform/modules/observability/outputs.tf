output "ops_topic_arn" {
  description = "ARN of the ops alert topic."
  value       = aws_sns_topic.ops_alerts.arn
}
