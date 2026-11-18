# 00-foundation: KMS keys, ECR repositories and CI identities of one
# environment. A human applies this stack; the pipeline's apply role cannot.

data "aws_partition" "current" {}

data "aws_caller_identity" "current" {
  lifecycle {
    postcondition {
      condition     = self.account_id == var.account_id
      error_message = "The credentials in use belong to another account than var.account_id."
    }
  }
}

locals {
  partition    = data.aws_partition.current.partition
  account_root = "arn:${local.partition}:iam::${var.account_id}:root"

  # Access to every key is delegated to IAM through the account root.
  key_policy_root = {
    Sid       = "AccountAdministration"
    Effect    = "Allow"
    Principal = { AWS = local.account_root }
    Action    = "kms:*"
    Resource  = "*"
  }

  # CloudWatch Logs may use the logs key for this environment's log groups only.
  key_policy_logs = {
    Sid       = "CloudWatchLogs"
    Effect    = "Allow"
    Principal = { Service = "logs.${var.aws_region}.amazonaws.com" }
    Action    = ["kms:Decrypt*", "kms:Describe*", "kms:Encrypt*", "kms:GenerateDataKey*", "kms:ReEncrypt*"]
    Resource  = "*"
    Condition = {
      ArnLike = {
        "kms:EncryptionContext:aws:logs:arn" = "arn:${local.partition}:logs:${var.aws_region}:${var.account_id}:log-group:/comparative/${var.env}/*"
      }
    }
  }

  symmetric_keys = {
    data    = { description = "data at rest: database, buckets, images", statements = [local.key_policy_root] }
    logs    = { description = "log groups", statements = [local.key_policy_root, local.key_policy_logs] }
    secrets = { description = "Secrets Manager secrets", statements = [local.key_policy_root] }
  }

  # Release images are tagged <component>-<full sha>. One lifecycle rule per
  # component, because an ECR rule with several prefixes matches only images
  # that carry all of them.
  repositories = {
    app   = ["web-", "worker-", "memory-worker-", "migrator-"]
    agent = ["agent-"]
  }

  parameters = {
    "kms/data_arn"       = aws_kms_key.symmetric["data"].arn
    "kms/logs_arn"       = aws_kms_key.symmetric["logs"].arn
    "kms/secrets_arn"    = aws_kms_key.symmetric["secrets"].arn
    "ecr/app_repo_url"   = aws_ecr_repository.this["app"].repository_url
    "ecr/agent_repo_url" = aws_ecr_repository.this["agent"].repository_url
  }
}

# --- KMS ---------------------------------------------------------------------

resource "aws_kms_key" "symmetric" {
  for_each = local.symmetric_keys

  description             = "Comparative ${var.env}: ${each.value.description}"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = each.value.statements
  })
}

resource "aws_kms_alias" "symmetric" {
  for_each = local.symmetric_keys

  name          = "alias/${var.name_prefix}-${each.key}"
  target_key_id = aws_kms_key.symmetric[each.key].key_id
}

# Asymmetric keys cannot rotate automatically; replacing this key means
# re-signing or re-trusting released images.
resource "aws_kms_key" "signing" {
  description              = "Comparative ${var.env}: release image signatures"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_NIST_P256"
  deletion_window_in_days  = 30

  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [local.key_policy_root]
  })
}

resource "aws_kms_alias" "signing" {
  name          = "alias/${var.name_prefix}-signing"
  target_key_id = aws_kms_key.signing.key_id
}

# --- ECR ---------------------------------------------------------------------

resource "aws_ecr_repository" "this" {
  for_each = local.repositories

  name                 = "${var.name_prefix}-${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.symmetric["data"].arn
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each = local.repositories

  repository = aws_ecr_repository.this[each.key].name

  policy = jsonencode({
    rules = concat(
      [{
        rulePriority = 1
        description  = "Expire untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      }],
      [
        for index, prefix in each.value : {
          rulePriority = index + 2
          description  = "Keep the last 60 ${prefix} release images"
          selection = {
            tagStatus     = "tagged"
            tagPrefixList = [prefix]
            countType     = "imageCountMoreThan"
            countNumber   = 60
          }
          action = { type = "expire" }
        }
      ],
    )
  })
}

# --- CI identities -----------------------------------------------------------

module "ci_identity" {
  source = "../../modules/ci-identity"

  env         = var.env
  name_prefix = var.name_prefix
  aws_region  = var.aws_region
  account_id  = data.aws_caller_identity.current.account_id

  create_oidc_provider = var.manage_account_singletons && var.create_oidc_provider
  create_evals_role    = var.manage_account_singletons
  manage_public_edge   = var.manage_public_edge

  github_owner         = var.github_owner
  github_repo          = var.github_repo
  github_owner_id      = var.github_owner_id
  github_repository_id = var.github_repository_id

  state_bucket_name = var.state_bucket_name
  state_kms_key_arn = var.state_kms_key_arn

  ecr_repository_arns   = [for repository in aws_ecr_repository.this : repository.arn]
  signing_key_arn       = aws_kms_key.signing.arn
  workload_kms_key_arns = [for key in aws_kms_key.symmetric : key.arn]

  eval_model_ids                = var.eval_model_ids
  eval_inference_profile_prefix = var.eval_inference_profile_prefix
  eval_inference_regions        = var.eval_inference_regions
}

# --- Published outputs -------------------------------------------------------

# Downstream stacks read these with aws_ssm_parameter data sources; there is no
# terraform_remote_state. The values are ARNs and URLs, not secrets.
resource "aws_ssm_parameter" "published" {
  #checkov:skip=CKV2_AWS_34:ARNs and repository URLs, not secrets; plain String so any downstream stack can read them
  for_each = local.parameters

  name  = "/comparative/${var.env}/00-foundation/${each.key}"
  type  = "String"
  value = each.value
}
