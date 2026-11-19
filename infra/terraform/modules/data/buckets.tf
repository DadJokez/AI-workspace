# Two buckets. Bucket names are global, so they carry the account and region.

locals {
  alb_logs_bucket  = "${var.name_prefix}-alb-logs-${var.account_id}-${var.aws_region}"
  artifacts_bucket = "${var.name_prefix}-artifacts-${var.account_id}-${var.aws_region}"
}

# --- Load balancer access logs -------------------------------------------------

# The load balancer writes to <bucket>/AWSLogs/<account>/...: it is configured
# with this bucket and no prefix.
resource "aws_s3_bucket" "alb_logs" {
  #checkov:skip=CKV_AWS_145:Load balancer log delivery supports S3-managed keys only, not KMS
  #checkov:skip=CKV_AWS_21:Logs expire after 30 days; versioning would keep the expired copies
  #checkov:skip=CKV_AWS_18:This is the log bucket; logging access to it needs a second log bucket nothing asks for
  #checkov:skip=CKV_AWS_144:Access logs are kept 30 days in one region; no replication requirement
  #checkov:skip=CKV2_AWS_62:Nothing consumes events from this bucket
  bucket = local.alb_logs_bucket

  # A disposable environment's destroy deletes the logs with the bucket.
  force_destroy = var.disposable
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Load balancer log delivery supports S3-managed keys only, not KMS.
resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  rule {
    id     = "expire-after-30-days"
    status = "Enabled"

    filter {}

    expiration {
      days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Only this account's load balancers in this region may deliver logs.
resource "aws_s3_bucket_policy" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowApplicationLoadBalancerLogDelivery"
      Effect    = "Allow"
      Principal = { Service = "logdelivery.elasticloadbalancing.amazonaws.com" }
      Action    = "s3:PutObject"
      Resource  = "arn:${local.partition}:s3:::${local.alb_logs_bucket}/AWSLogs/${var.account_id}/*"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.account_id }
        ArnLike = {
          "aws:SourceArn" = "arn:${local.partition}:elasticloadbalancing:${var.aws_region}:${var.account_id}:loadbalancer/*"
        }
      }
    }]
  })

  # A policy cannot be attached while the public access block is being set.
  depends_on = [aws_s3_bucket_public_access_block.alb_logs]
}

# --- Artifacts -------------------------------------------------------------------

# Nothing reads or writes this bucket yet.
resource "aws_s3_bucket" "artifacts" {
  #checkov:skip=CKV_AWS_18:Empty until the application uses it; access logging is decided with that first use
  #checkov:skip=CKV_AWS_144:Single-region environment; no replication requirement
  #checkov:skip=CKV2_AWS_61:Empty until the application uses it; retention is decided with that first use
  #checkov:skip=CKV2_AWS_62:Nothing consumes events from this bucket
  bucket = local.artifacts_bucket

  force_destroy = var.disposable
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.data_kms_key_arn
    }
  }
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}
