# Inputs only this stack reads, plus three it shares with 40-services:
# bedrock_model_ids, bedrock_inference_profile_prefix and
# bedrock_inference_regions.

# --- the release: envs/<env>/release.auto.tfvars -------------------------------

variable "image_agent" {
  description = "Agent image of the release (linux/arm64), by digest."
  type        = string
}

# --- network --------------------------------------------------------------------

variable "agentcore_network_mode" {
  description = "Network mode of the runtime: PUBLIC in the sandbox, VPC in firewall mode (the agentcore subnets and the agent_runtime security group of 10-network)."
  type        = string
}

variable "agentcore_browser_network_mode" {
  description = "Network mode of the Studio Browser. VPC keeps it in the agentcore subnets with the studio_browser security group, which reaches only the browser proxy and DNS; PUBLIC leaves only the session's proxy setting between the browser and the internet."
  type        = string
}

# --- web search -----------------------------------------------------------------

variable "agentcore_web_search_provider" {
  description = "Web search of the agent: brave reads the key from the field BRAVE_SEARCH_API_KEY of the app secret through an AgentCore credential provider; none offers no web search tool. Keep it in step with WEB_SEARCH_PROVIDER of the services."
  type        = string
}

# --- models ---------------------------------------------------------------------

variable "bedrock_model_ids" {
  description = "Bedrock foundation-model ids the agent may invoke, without an inference-profile prefix."
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
  description = "Regions the inference profile routes to; the agent may invoke the foundation models there."
  type        = list(string)

  validation {
    condition     = length(var.bedrock_inference_regions) > 0 && alltrue([for region in var.bedrock_inference_regions : can(regex("^[a-z0-9-]+$", region))])
    error_message = "bedrock_inference_regions must list at least one region name, each without a wildcard."
  }
}
