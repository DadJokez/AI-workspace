# The data layer of one environment: the PostgreSQL instance (this file), an
# optional RDS Proxy (proxy.tf), the secrets (secrets.tf) and the buckets
# (buckets.tf).
#
# No secret value passes through Terraform's plan or state: RDS owns the master
# password, the application secrets are created empty and filled by a human,
# and the one generated password is ephemeral and written through a write-only
# argument.

data "aws_partition" "current" {}

locals {
  partition = data.aws_partition.current.partition
}

resource "aws_db_subnet_group" "this" {
  name        = "${var.name_prefix}-db"
  description = "Data subnets of Comparative ${var.env}."
  subnet_ids  = var.data_subnet_ids
}

resource "aws_db_parameter_group" "this" {
  name        = "${var.name_prefix}-postgres16"
  family      = "postgres16"
  description = "Comparative ${var.env}: TLS required, slow statements logged."

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = tostring(var.log_min_duration_statement)
  }
}

resource "aws_db_instance" "this" {
  #checkov:skip=CKV_AWS_157:Multi-AZ is var.multi_az, false in the sandbox and true where the environment asks for it
  #checkov:skip=CKV_AWS_118:Enhanced monitoring is not part of this stack; Performance Insights is on, and OS metrics are an observability decision
  #checkov:skip=CKV_AWS_129:Log export would create a log group outside /comparative/<env>/, which the logs key does not cover; logs stay on the instance
  #checkov:skip=CKV_AWS_161:The application logs in with a password from DATABASE_URL; IAM database authentication is not used
  identifier = "${var.name_prefix}-db"

  engine         = "postgres"
  engine_version = var.engine_version
  # The default, stated: RDS applies minor versions in the maintenance window.
  auto_minor_version_upgrade = true
  instance_class             = var.instance_class
  multi_az                   = var.multi_az

  storage_type          = "gp3"
  allocated_storage     = 20
  max_allocated_storage = var.max_allocated_storage
  storage_encrypted     = true
  kms_key_id            = var.data_kms_key_arn

  db_name  = var.db_name
  username = var.master_username

  # RDS creates and rotates the master password in a secret of its own; no
  # password is ever an argument here.
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.secrets_kms_key_arn

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.db_security_group_id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.this.name

  backup_retention_period = var.backup_days
  copy_tags_to_snapshot   = true
  deletion_protection     = true

  # 7 days is the retention Performance Insights does not charge for.
  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  performance_insights_kms_key_id       = var.data_kms_key_arn

  snapshot_identifier       = var.restore_snapshot_id
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name_prefix}-db-final"

  lifecycle {
    # The snapshot seeds a new instance only. Changing or clearing the variable
    # afterwards must not replace the database.
    ignore_changes = [snapshot_identifier]
  }
}
