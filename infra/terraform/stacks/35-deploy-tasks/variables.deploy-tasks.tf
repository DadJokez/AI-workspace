# Inputs only this stack reads, plus two it shares with 40-services:
# image_worker and internal_base_url.

# --- the release: envs/<env>/release.auto.tfvars -------------------------------

variable "release_id" {
  description = "Identifier of the release, the commit it was built from. The smoke task reports under it."
  type        = string
}

variable "image_migrator" {
  description = "Migrator image of the release, by digest."
  type        = string
}

variable "image_worker" {
  description = "Worker image of the release, by digest. The smoke task runs from it."
  type        = string
}

# --- envs/<env>/env.tfvars -------------------------------------------------------

variable "internal_base_url" {
  description = "URL the application is reached at from inside the network, when that differs from the public one. Empty = the public URL."
  type        = string
  default     = ""
}

variable "snapshot_keep_days" {
  description = "Days the pipeline keeps the pre-migrate-* database snapshots it takes before each release's migrations. Published to SSM for the apply workflow."
  type        = number

  validation {
    condition     = var.snapshot_keep_days >= 1 && floor(var.snapshot_keep_days) == var.snapshot_keep_days
    error_message = "snapshot_keep_days must be a whole number of days, at least 1."
  }
}
