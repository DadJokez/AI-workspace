variable "env" {
  description = "Environment name. It is also the GitHub environment the apply role trusts."
  type        = string
}

variable "name_prefix" {
  description = "Prefix of every resource name, cmp-<env>."
  type        = string
}

variable "aws_region" {
  description = "Home region of the environment."
  type        = string
}

variable "account_id" {
  description = "AWS account the roles live in."
  type        = string
}

variable "create_oidc_provider" {
  description = "Create the account's GitHub Actions OIDC provider. When false the existing one is looked up."
  type        = bool
}

variable "create_evals_role" {
  description = "Create the Bedrock-invoke-only evals role (one per account)."
  type        = bool
}

variable "github_owner" {
  description = "Owner (user or organization) of the repository that may assume the roles."
  type        = string
}

variable "github_repo" {
  description = "Name of the repository that may assume the roles, without the owner."
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
  description = "Name of the Terraform state bucket."
  type        = string
}

variable "state_kms_key_arn" {
  description = "ARN of the KMS key that encrypts the Terraform state bucket."
  type        = string
}

variable "ecr_repository_arns" {
  description = "ARNs of the ECR repositories the image-push role may push to."
  type        = list(string)
}

variable "signing_key_arn" {
  description = "ARN of the asymmetric KMS key that signs images."
  type        = string
}

variable "workload_kms_key_arns" {
  description = "ARNs of the KMS keys the apply role may use (not administer) for the resources it manages."
  type        = list(string)
}

variable "manage_public_edge" {
  description = "Give the apply role Route 53, ACM and WAF permissions. Only for environments that use them."
  type        = bool
}

variable "eval_model_ids" {
  description = "Bedrock foundation-model ids the evals role may invoke, without an inference-profile prefix."
  type        = list(string)
}

variable "eval_inference_profile_prefix" {
  description = "Inference-profile prefix of the eval models, for example \"us.\". Empty means no inference profile."
  type        = string
}

variable "eval_inference_regions" {
  description = "Regions the inference profile routes to; the evals role may invoke the foundation models there."
  type        = list(string)
}
