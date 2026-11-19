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
  description = "AWS account of the environment. It scopes the roles' trust and the AgentCore and log ARNs."
  type        = string
}

# --- the runtime ----------------------------------------------------------------

variable "image" {
  description = "Agent image (linux/arm64) in an ECR repository, by digest: <account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<digest>."
  type        = string

  # A tag can be moved to another image; a digest cannot. The repository part
  # is read to scope the runtime role's pull permission.
  validation {
    condition     = can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com(\\.cn)?/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$", var.image))
    error_message = "image must name an ECR image by digest (<account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<64 hex digits>); a tag is not accepted."
  }
}

variable "network_mode" {
  description = "Network mode of the runtime: PUBLIC (AgentCore's own network) or VPC (in subnet_ids with runtime_security_group_id)."
  type        = string

  validation {
    condition     = contains(["PUBLIC", "VPC"], var.network_mode)
    error_message = "network_mode must be PUBLIC or VPC."
  }
}

variable "runtime_security_group_id" {
  description = "Security group of the runtime in VPC mode (agent_runtime of 10-network)."
  type        = string
}

variable "bedrock_model_arns" {
  description = "Inference-profile and foundation-model ARNs the agent may invoke. Never a wildcard."
  type        = list(string)

  validation {
    condition     = length(var.bedrock_model_arns) > 0 && alltrue([for arn in var.bedrock_model_arns : can(regex("^arn:[a-z-]+:bedrock:[a-z0-9-]+:[0-9]*:(inference-profile|foundation-model)/[A-Za-z0-9.:_-]+$", arn))])
    error_message = "bedrock_model_arns must list at least one inference-profile or foundation-model ARN, each without a wildcard."
  }
}

variable "bedrock_inference_profile_prefix" {
  description = "Inference-profile prefix the agent puts in front of a model id (BEDROCK_INFERENCE_PROFILE_PREFIX); empty for none."
  type        = string
}

variable "web_search_provider" {
  description = "Web search of the agent: brave (through an AgentCore API key credential provider) or none (the tool is not offered)."
  type        = string

  validation {
    condition     = contains(["brave", "none"], var.web_search_provider)
    error_message = "web_search_provider must be brave or none."
  }
}

variable "web_search_secret_arn" {
  description = "Secret whose JSON field BRAVE_SEARCH_API_KEY holds the Brave key (the app secret of 20-data). Read only when web_search_provider is brave."
  type        = string
}

variable "proxy_url" {
  description = "Outbound proxy of a VPC-mode runtime (HTTPS_PROXY, HTTP_PROXY); empty for none. A PUBLIC runtime is outside the VPC and gets no proxy."
  type        = string
  default     = ""
}

variable "no_proxy" {
  description = "NO_PROXY of a VPC-mode runtime that has a proxy."
  type        = string
  default     = ""
}

# --- the Studio Browser -----------------------------------------------------------

variable "browser_network_mode" {
  description = "Network mode of the Studio Browser: VPC (in subnet_ids with browser_security_group_id, which can reach only the browser proxy and DNS) or PUBLIC (AgentCore's own network, nothing but the session's proxy setting between the browser and the internet)."
  type        = string

  validation {
    condition     = contains(["PUBLIC", "VPC"], var.browser_network_mode)
    error_message = "browser_network_mode must be PUBLIC or VPC."
  }
}

variable "browser_security_group_id" {
  description = "Security group of the Studio Browser in VPC mode (studio_browser of 10-network)."
  type        = string
}

variable "browser_proxy_secret_arn" {
  description = "Secret with the credentials the browser presents to the browser proxy; the browser's execution role may read it."
  type        = string
}

# --- shared -----------------------------------------------------------------------

variable "subnet_ids" {
  description = "Subnets in zones AgentCore supports (agentcore_subnet_ids of 10-network), for whichever of the two runs in VPC mode."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) > 0 || (var.network_mode == "PUBLIC" && var.browser_network_mode == "PUBLIC")
    error_message = "subnet_ids must name at least one subnet when the runtime or the browser runs in VPC mode."
  }
}

variable "kms_secrets_arn" {
  description = "KMS key of the environment's secrets; the browser's execution role may decrypt with it through Secrets Manager."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Workload permissions boundary set on both roles."
  type        = string
}
