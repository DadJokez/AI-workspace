# Values a human needs for the database bootstrap (see ../../README.md). What
# other stacks need is published to SSM in main.tf instead.

output "db_master_user_secret_arn" {
  description = "ARN of the secret in which RDS keeps the master user's password. An ARN, not the password."
  value       = module.data.db_master_user_secret_arn
}

output "db_proxy_endpoint" {
  description = "Host name of the RDS Proxy, or null when enable_rds_proxy is false."
  value       = module.data.db_proxy_endpoint
}
