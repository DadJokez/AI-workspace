# 20-data: the PostgreSQL instance, an optional RDS Proxy, the secrets and the
# buckets of one environment.

data "aws_partition" "current" {}

data "aws_caller_identity" "current" {
  lifecycle {
    postcondition {
      condition     = self.account_id == var.account_id
      error_message = "The credentials in use belong to another account than var.account_id."
    }
  }
}

# ARNs and ids, not secrets: insecure_value keeps them readable in the plan.
data "aws_ssm_parameter" "data_kms_key_arn" {
  name = "/comparative/${var.env}/00-foundation/kms/data_arn"
}

data "aws_ssm_parameter" "secrets_kms_key_arn" {
  name = "/comparative/${var.env}/00-foundation/kms/secrets_arn"
}

data "aws_ssm_parameter" "data_subnet_ids" {
  name = "/comparative/${var.env}/10-network/data_subnet_ids"
}

data "aws_ssm_parameter" "db_security_group_id" {
  name = "/comparative/${var.env}/10-network/sg/db_id"
}

locals {
  # 00-foundation names the workload boundary <name_prefix>-workload-boundary
  # and does not publish its ARN.
  permissions_boundary_arn = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:policy/${var.name_prefix}-workload-boundary"

  parameters = {
    "db/endpoint"                 = module.data.db_address
    "db/port"                     = tostring(module.data.db_port)
    "db/instance_id"              = module.data.db_instance_id
    "secret/app_arn"              = module.data.secret_arns["app"]
    "secret/browser_proxy_arn"    = module.data.secret_arns["browser-proxy"]
    "secret/browser_proxy_db_arn" = module.data.secret_arns["browser-proxy-db"]
    "bucket/alb_logs"             = module.data.alb_logs_bucket
    "bucket/artifacts"            = module.data.artifacts_bucket
  }
}

module "data" {
  source = "../../modules/data"

  env         = var.env
  name_prefix = var.name_prefix
  aws_region  = var.aws_region
  account_id  = data.aws_caller_identity.current.account_id

  # 10-network publishes subnet lists as JSON arrays.
  data_subnet_ids      = jsondecode(data.aws_ssm_parameter.data_subnet_ids.insecure_value)
  db_security_group_id = data.aws_ssm_parameter.db_security_group_id.insecure_value

  data_kms_key_arn         = data.aws_ssm_parameter.data_kms_key_arn.insecure_value
  secrets_kms_key_arn      = data.aws_ssm_parameter.secrets_kms_key_arn.insecure_value
  permissions_boundary_arn = local.permissions_boundary_arn

  engine_version             = var.db_engine_version
  instance_class             = var.db_instance_class
  multi_az                   = var.db_multi_az
  max_allocated_storage      = var.db_max_allocated_storage
  backup_days                = var.db_backup_days
  log_min_duration_statement = var.db_log_min_duration_statement
  db_name                    = var.db_name
  master_username            = var.db_master_username
  restore_snapshot_id        = var.db_restore_snapshot_id
  enable_rds_proxy           = var.enable_rds_proxy
}

# --- Published outputs -------------------------------------------------------

# Downstream stacks read these with aws_ssm_parameter data sources; there is no
# terraform_remote_state. The values are host names, ARNs and bucket names, not
# secrets.
resource "aws_ssm_parameter" "published" {
  #checkov:skip=CKV2_AWS_34:Host names, ARNs and bucket names, not secrets; plain String so any downstream stack can read them
  for_each = local.parameters

  name  = "/comparative/${var.env}/20-data/${each.key}"
  type  = "String"
  value = each.value
}
