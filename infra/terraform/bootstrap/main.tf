# One-time, per account: the Terraform state bucket and its KMS key. Applied by
# a human with local state, then the state is migrated into the bucket it
# created. See ../README.md, "First run".

terraform {
  required_version = "~> 1.17"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
  }

  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

variable "aws_region" {
  description = "Region of the state bucket."
  type        = string
}

variable "account_id" {
  description = "AWS account the state bucket belongs to."
  type        = string
}

variable "tags" {
  description = "Tags applied to the bucket and the key."
  type        = map(string)
}

data "aws_partition" "current" {}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = var.tags
  }
}

resource "aws_kms_key" "state" {
  description             = "Comparative Terraform state"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  # Access is delegated to IAM through the account root.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AccountAdministration"
      Effect    = "Allow"
      Principal = { AWS = "arn:${data.aws_partition.current.partition}:iam::${var.account_id}:root" }
      Action    = "kms:*"
      Resource  = "*"
    }]
  })
}

resource "aws_kms_alias" "state" {
  name          = "alias/comparative-tfstate"
  target_key_id = aws_kms_key.state.key_id
}

resource "aws_s3_bucket" "state" {
  #checkov:skip=CKV_AWS_18:The state bucket is the first resource in the account; there is no log bucket to deliver access logs to
  #checkov:skip=CKV_AWS_144:State is rebuilt from the configuration, not replicated to a second region
  #checkov:skip=CKV2_AWS_61:Every state version is kept on purpose; old versions are the recovery path
  #checkov:skip=CKV2_AWS_62:Nothing consumes events from the state bucket
  bucket = "comparative-tfstate-${var.account_id}-${var.aws_region}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.state]
}

output "state_bucket_name" {
  description = "Goes into backend.hcl (bucket) and env.tfvars (state_bucket_name)."
  value       = aws_s3_bucket.state.bucket
}

output "state_kms_key_arn" {
  description = "Goes into backend.hcl (kms_key_id) and env.tfvars (state_kms_key_arn)."
  value       = aws_kms_key.state.arn
}
