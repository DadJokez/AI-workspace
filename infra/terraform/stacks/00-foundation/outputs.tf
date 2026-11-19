# Values a human copies into GitHub repository or environment variables. What
# other stacks need is published to SSM in main.tf instead.

output "tf_plan_role_arn" {
  description = "Role the plan workflow assumes."
  value       = module.ci_identity.tf_plan_role_arn
}

output "tf_apply_role_arn" {
  description = "Role the apply workflow assumes from the GitHub environment."
  value       = module.ci_identity.tf_apply_role_arn
}

output "image_push_role_arn" {
  description = "Role the build workflow assumes on main."
  value       = module.ci_identity.image_push_role_arn
}

output "evals_role_arn" {
  description = "Role the eval workflows assume, or null when another environment owns it."
  value       = module.ci_identity.evals_role_arn
}

output "workload_boundary_policy_arn" {
  description = "Permissions boundary every role under /comparative/<env>/ must carry."
  value       = module.ci_identity.workload_boundary_policy_arn
}

output "signing_key_arn" {
  description = "KMS key that signs and verifies release images."
  value       = aws_kms_key.signing.arn
}

output "break_glass_role_arn" {
  description = "Role a named person assumes, with MFA, when the pipeline cannot make a change (docs/runbooks/BREAK_GLASS.md)."
  value       = module.ci_identity.break_glass_role_arn
}
