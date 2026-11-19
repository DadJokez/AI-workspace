output "oidc_provider_arn" {
  description = "ARN of the GitHub Actions OIDC provider the roles trust."
  value       = local.oidc_provider_arn
}

output "tf_plan_role_arn" {
  description = "ARN of the read-only plan role."
  value       = aws_iam_role.tf_plan.arn
}

output "tf_apply_role_arn" {
  description = "ARN of the apply role."
  value       = aws_iam_role.tf_apply.arn
}

output "image_push_role_arn" {
  description = "ARN of the image push and signing role."
  value       = aws_iam_role.image_push.arn
}

output "evals_role_arn" {
  description = "ARN of the evals role, or null when this environment does not own it."
  value       = one(aws_iam_role.evals[*].arn)
}

output "workload_boundary_policy_arn" {
  description = "Permissions boundary every role under /comparative/<env>/ must carry."
  value       = aws_iam_policy.workload_boundary.arn
}

output "break_glass_role_arn" {
  description = "ARN of the break-glass role (docs/runbooks/BREAK_GLASS.md)."
  value       = aws_iam_role.break_glass.arn
}

output "break_glass_rule_arn" {
  description = "ARN of the EventBridge rule that reports every assumption of the break-glass role; the ops topic's policy lets it publish."
  value       = aws_cloudwatch_event_rule.break_glass_assumed.arn
}
