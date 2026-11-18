# Inputs only this stack reads, plus three it shares: image_worker and
# internal_base_url (also read by 35-deploy-tasks) and internal_namespace
# (also read by 30-platform).

# --- the release: envs/<env>/release.auto.tfvars -------------------------------

variable "image_web" {
  description = "Web image of the release, by digest."
  type        = string
}

variable "image_worker" {
  description = "Worker image of the release, by digest. The chat worker and the browser proxy run from it."
  type        = string
}

variable "image_memory_worker" {
  description = "Memory-worker image of the release, by digest."
  type        = string
}

# --- sizes ----------------------------------------------------------------------

variable "web_min" {
  description = "Fewest web tasks autoscaling keeps running."
  type        = number
}

variable "web_max" {
  description = "Most web tasks autoscaling starts."
  type        = number
}

variable "chat_worker_count" {
  description = "Number of chat-worker tasks."
  type        = number
}

# --- addresses ------------------------------------------------------------------

variable "internal_namespace" {
  description = "Name of the Cloud Map private DNS namespace 30-platform creates."
  type        = string
}

variable "internal_base_url" {
  description = "URL the application is reached at from inside the network, handed to AgentCore. Empty leaves INTERNAL_BASE_URL unset."
  type        = string
  default     = ""
}

variable "legacy_host_redirect_from" {
  description = "Former host name whose requests the web service redirects to the current one; empty for none."
  type        = string
  default     = ""
}

# --- invitation email -----------------------------------------------------------

variable "invite_email_provider" {
  description = "Provider that sends invitation email, for example \"ses\"."
  type        = string
}

variable "invite_email_from" {
  description = "Sender address of invitation email."
  type        = string
}

variable "invite_email_identity" {
  description = "SES identity (domain or address) the web service may send from."
  type        = string
}

variable "invite_email_aws_region" {
  description = "Region of that SES identity; null = aws_region."
  type        = string
  default     = null
}

# --- models ---------------------------------------------------------------------

variable "bedrock_model_ids" {
  description = "Bedrock foundation-model ids the services may invoke, without an inference-profile prefix."
  type        = list(string)

  validation {
    condition     = length(var.bedrock_model_ids) > 0 && alltrue([for id in var.bedrock_model_ids : can(regex("^[A-Za-z0-9.:_-]+$", id))])
    error_message = "bedrock_model_ids must list at least one model id, each without a wildcard."
  }
}

variable "bedrock_inference_profile_prefix" {
  description = "Inference-profile prefix of those models, for example \"us.\". Empty means the models are invoked directly, without a profile."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)?$", var.bedrock_inference_profile_prefix))
    error_message = "bedrock_inference_profile_prefix must be empty or a prefix ending in a dot, for example \"us.\"."
  }
}

variable "bedrock_inference_regions" {
  description = "Regions the inference profile routes to; the services may invoke the foundation models there."
  type        = list(string)

  validation {
    condition     = length(var.bedrock_inference_regions) > 0 && alltrue([for region in var.bedrock_inference_regions : can(regex("^[a-z0-9-]+$", region))])
    error_message = "bedrock_inference_regions must list at least one region name, each without a wildcard."
  }
}

# --- switches -------------------------------------------------------------------

variable "agentcore_browser_enabled" {
  description = "Offer the AgentCore Browser of 50-agentcore in the web service."
  type        = bool
}

variable "extra_environment" {
  description = "More environment variables for the web service and both workers: the switches of the configuration contract. Never secret values."
  type        = map(string)
  default     = {}
}

variable "optional_app_secret_fields" {
  description = "Fields of the app secret the web service reads besides the always-present ones, for example OIDC_CLIENT_SECRET. Each must exist in the secret."
  type        = list(string)
  default     = []
}
