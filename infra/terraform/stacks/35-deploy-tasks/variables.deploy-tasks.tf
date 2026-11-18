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
