# Inputs only this stack reads. Each is passed to modules/data unchanged; the
# module validates them.

variable "db_engine_version" {
  description = "PostgreSQL 16 version: \"16.13\", or \"16\" to follow the minor versions RDS applies automatically."
  type        = string
}

variable "db_instance_class" {
  description = "Database instance class."
  type        = string
}

variable "db_multi_az" {
  description = "True = a standby in a second availability zone."
  type        = bool
}

variable "db_max_allocated_storage" {
  description = "Upper limit of storage autoscaling in GB. Storage starts at 20 GB."
  type        = number
}

variable "db_backup_days" {
  description = "Days automated backups are kept."
  type        = number
}

variable "db_log_min_duration_statement" {
  description = "Statements running at least this many milliseconds are logged. -1 logs none."
  type        = number
}

variable "db_name" {
  description = "Database created in a new instance. When restoring, the name of the database in the snapshot."
  type        = string
}

variable "db_master_username" {
  description = "Master user of a new instance. When restoring, the master user of the snapshot."
  type        = string
}

variable "db_restore_snapshot_id" {
  description = "Snapshot a new instance is restored from; null creates an empty database."
  type        = string
  default     = null
}

variable "enable_rds_proxy" {
  description = "Put an RDS Proxy in front of the instance."
  type        = bool
  default     = false
}
