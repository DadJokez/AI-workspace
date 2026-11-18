output "db_address" {
  description = "Host name of the database instance."
  value       = aws_db_instance.this.address
}

output "db_port" {
  description = "Port of the database instance."
  value       = aws_db_instance.this.port
}

output "db_instance_id" {
  description = "Identifier of the database instance."
  value       = aws_db_instance.this.identifier
}

output "db_master_user_secret_arn" {
  description = "ARN of the secret in which RDS keeps the master user's password."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "db_proxy_endpoint" {
  description = "Host name of the RDS Proxy, or null when there is none."
  value       = one(aws_db_proxy.this[*].endpoint)
}

output "secret_arns" {
  description = "Secret ARNs by name: app, browser-proxy, browser-proxy-db, and db-proxy-auth when the proxy is on."
  value       = { for name, secret in aws_secretsmanager_secret.this : name => secret.arn }
}

output "alb_logs_bucket" {
  description = "Name of the bucket for load balancer access logs."
  value       = aws_s3_bucket.alb_logs.bucket
}

output "artifacts_bucket" {
  description = "Name of the artifacts bucket."
  value       = aws_s3_bucket.artifacts.bucket
}
