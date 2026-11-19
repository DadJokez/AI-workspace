# Inputs only this stack reads.

variable "manage_account_singletons" {
  description = "True in exactly one environment per account: that environment owns the per-account resources (the GitHub OIDC provider when create_oidc_provider is set, and the evals role)."
  type        = bool
}

variable "create_oidc_provider" {
  description = "Create the GitHub Actions OIDC provider. False while another owner (the CDK eval stack) still holds it; the existing provider is then looked up."
  type        = bool
}

variable "manage_public_edge" {
  description = "Give the apply role Route 53, ACM and WAF permissions. Only for environments that use them."
  type        = bool
}

variable "github_owner" {
  description = "Owner (user or organization) of the repository whose workflows assume the CI roles."
  type        = string
}

variable "github_repo" {
  description = "Name of that repository, without the owner."
  type        = string
}

variable "github_owner_id" {
  description = "Numeric GitHub id of the repository owner."
  type        = string
}

variable "github_repository_id" {
  description = "Numeric GitHub id of the repository."
  type        = string
}

variable "state_bucket_name" {
  description = "Terraform state bucket created by bootstrap/."
  type        = string
}

variable "state_kms_key_arn" {
  description = "ARN of the KMS key created by bootstrap/ that encrypts the state bucket."
  type        = string
}

variable "eval_model_ids" {
  description = "Bedrock foundation-model ids the evals role may invoke, without an inference-profile prefix."
  type        = list(string)
}

variable "eval_inference_profile_prefix" {
  description = "Inference-profile prefix of the eval models, for example \"us.\"."
  type        = string
}

variable "eval_inference_regions" {
  description = "Regions the inference profile routes to."
  type        = list(string)
}

variable "break_glass_principal_arns" {
  description = "IAM users or roles that may assume the break-glass role, each with MFA (docs/runbooks/BREAK_GLASS.md)."
  type        = list(string)
}
