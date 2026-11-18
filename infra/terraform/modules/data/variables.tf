variable "env" {
  description = "Environment name."
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
  description = "AWS account of the environment. Part of the bucket names, which are global, and of the secret and log-delivery policies."
  type        = string
}

# --- supplied by 10-network --------------------------------------------------

variable "data_subnet_ids" {
  description = "Subnets of the database, in at least two availability zones."
  type        = list(string)

  validation {
    condition     = length(var.data_subnet_ids) >= 2
    error_message = "A DB subnet group needs subnets in at least two availability zones."
  }
}

variable "db_security_group_id" {
  description = "Security group of the database."
  type        = string
}

# --- supplied by 00-foundation -----------------------------------------------

variable "data_kms_key_arn" {
  description = "KMS key for data at rest: database storage, Performance Insights, the artifacts bucket."
  type        = string
}

variable "secrets_kms_key_arn" {
  description = "KMS key that encrypts the Secrets Manager secrets, the database's master secret included."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary every role under /comparative/<env>/ must carry."
  type        = string
}

# --- database ----------------------------------------------------------------

variable "engine_version" {
  description = "PostgreSQL 16 version: \"16.13\", or \"16\" to follow the minor versions RDS applies automatically."
  type        = string

  validation {
    condition     = can(regex("^16(\\.[0-9]+)?$", var.engine_version))
    error_message = "engine_version must be 16 or 16.<minor>; the parameter group is for PostgreSQL 16."
  }
}

variable "instance_class" {
  description = "Instance class, for example db.t4g.micro."
  type        = string
}

variable "multi_az" {
  description = "True = a standby in a second availability zone."
  type        = bool
}

variable "max_allocated_storage" {
  description = "Upper limit of storage autoscaling in GB. Storage starts at 20 GB."
  type        = number

  validation {
    condition     = var.max_allocated_storage > 20
    error_message = "max_allocated_storage must be above the 20 GB the instance starts with."
  }
}

variable "backup_days" {
  description = "Days automated backups are kept."
  type        = number

  validation {
    condition     = var.backup_days >= 1 && var.backup_days <= 35
    error_message = "backup_days must be between 1 and 35; 0 would turn backups off."
  }
}

variable "log_min_duration_statement" {
  description = "Statements running at least this many milliseconds are logged. -1 logs none, 0 logs all."
  type        = number
}

variable "db_name" {
  description = "Database created in a new instance. When restoring, the name of the database in the snapshot."
  type        = string
}

variable "master_username" {
  description = "Master user of a new instance. When restoring, the master user of the snapshot."
  type        = string
}

variable "restore_snapshot_id" {
  description = "Snapshot a new instance is restored from; null creates an empty database. Read only when the instance is created."
  type        = string
  default     = null
}

variable "enable_rds_proxy" {
  description = "Put an RDS Proxy in front of the instance."
  type        = bool
  default     = false
}
