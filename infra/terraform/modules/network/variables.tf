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

variable "mode" {
  description = "\"create\" builds a VPC; \"adopt\" uses the VPC and subnets a landing zone supplies."
  type        = string

  validation {
    condition     = contains(["create", "adopt"], var.mode)
    error_message = "mode must be \"create\" or \"adopt\"."
  }
}

# --- create mode -------------------------------------------------------------

variable "vpc_cidr" {
  description = "Create mode: IPv4 CIDR of the VPC, a /16. Subnets are /20."
  type        = string
  default     = null

  validation {
    condition     = var.mode != "create" || try(cidrhost(var.vpc_cidr, 0) != "" && tonumber(split("/", var.vpc_cidr)[1]) == 16, false)
    error_message = "Create mode needs vpc_cidr, an IPv4 /16."
  }
}

variable "az_count" {
  description = "Create mode: number of availability zones, each with one app, one data and (when needed) one public subnet."
  type        = number
  default     = 2

  validation {
    condition     = contains([1, 2, 3, 4], var.az_count)
    error_message = "az_count must be between 1 and 4."
  }
}

# --- adopt mode --------------------------------------------------------------

variable "vpc_id" {
  description = "Adopt mode: id of the landing zone's VPC."
  type        = string
  default     = null

  validation {
    condition     = var.mode != "adopt" || try(startswith(var.vpc_id, "vpc-"), false)
    error_message = "Adopt mode needs vpc_id."
  }
}

variable "app_subnet_ids" {
  description = "Adopt mode: subnets for the services."
  type        = list(string)
  default     = []

  validation {
    condition     = var.mode != "adopt" || length(var.app_subnet_ids) > 0
    error_message = "Adopt mode needs app_subnet_ids."
  }
}

variable "data_subnet_ids" {
  description = "Adopt mode: subnets for the database."
  type        = list(string)
  default     = []

  validation {
    condition     = var.mode != "adopt" || length(var.data_subnet_ids) > 0
    error_message = "Adopt mode needs data_subnet_ids."
  }
}

variable "public_subnet_ids" {
  description = "Adopt mode: subnets for a public load balancer. Empty when the load balancer is internal."
  type        = list(string)
  default     = []

  validation {
    condition     = var.mode != "adopt" || var.internal_alb || length(var.public_subnet_ids) > 0
    error_message = "Adopt mode with a public load balancer needs public_subnet_ids."
  }
}

# --- exposure and egress -----------------------------------------------------

variable "firewall_mode" {
  description = "True = no internet route from the app subnets; AWS APIs are reached through interface endpoints."
  type        = bool

  validation {
    condition     = var.firewall_mode == (var.egress == "proxy")
    error_message = "firewall_mode = true goes with egress = \"proxy\", and firewall_mode = false with egress = \"nat\"."
  }
}

variable "internal_alb" {
  description = "True = the load balancer is internal; no public subnets are needed for it."
  type        = bool
}

variable "alb_ingress_cidrs" {
  description = "IPv4 ranges that may reach the load balancer on 443 and 80. 0.0.0.0/0 is accepted only when internal_alb is false."
  type        = list(string)

  validation {
    condition     = alltrue([for cidr in var.alb_ingress_cidrs : can(cidrhost(cidr, 0))])
    error_message = "alb_ingress_cidrs must be IPv4 CIDR ranges."
  }

  validation {
    condition     = !var.internal_alb || !contains(var.alb_ingress_cidrs, "0.0.0.0/0")
    error_message = "An internal load balancer cannot take ingress from 0.0.0.0/0."
  }
}

variable "egress" {
  description = "\"nat\" = one NAT gateway (sandbox). \"proxy\" = no default route; outbound traffic goes through the proxy only."
  type        = string

  validation {
    condition     = contains(["nat", "proxy"], var.egress)
    error_message = "egress must be \"nat\" or \"proxy\"."
  }
}

variable "proxy_url" {
  description = "URL of the organisation's forward proxy, http://host:port. Empty with egress = \"proxy\" and create_standin_proxy = true builds the stand-in."
  type        = string
  default     = ""

  validation {
    condition     = var.proxy_url == "" || can(regex("^https?://[A-Za-z0-9.-]+:[0-9]+$", var.proxy_url))
    error_message = "proxy_url must be http://host:port or https://host:port, with the port stated and no path."
  }

  validation {
    condition     = var.egress == "proxy" ? (var.proxy_url != "") != var.create_standin_proxy : var.proxy_url == ""
    error_message = "egress = \"proxy\" needs exactly one of proxy_url and create_standin_proxy; egress = \"nat\" takes neither."
  }
}

variable "proxy_cidrs" {
  description = "IPv4 ranges the proxy at proxy_url answers from. The security groups open the proxy port to these ranges only. Not used with the stand-in."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for cidr in var.proxy_cidrs : can(cidrhost(cidr, 0))])
    error_message = "proxy_cidrs must be IPv4 CIDR ranges."
  }

  validation {
    condition     = (var.proxy_url != "") == (length(var.proxy_cidrs) > 0)
    error_message = "proxy_cidrs is set exactly when proxy_url is."
  }
}

variable "create_standin_proxy" {
  description = "Build a small allowlisting forward proxy that imitates the organisation's. Rehearsal environments only."
  type        = bool
  default     = false

  validation {
    condition     = !var.create_standin_proxy || (var.mode == "create" && var.egress == "proxy")
    error_message = "The stand-in proxy needs mode = \"create\" and egress = \"proxy\"."
  }
}

variable "proxy_allowlist" {
  description = "Hosts the stand-in proxy lets through (the output of `pnpm egress:inventory --allowlist`). A leading dot matches the domain and every subdomain."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for host in var.proxy_allowlist : can(regex("^\\.?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", host))])
    error_message = "proxy_allowlist entries are lower-case host names, optionally with a leading dot."
  }

  validation {
    condition     = !var.create_standin_proxy || length(var.proxy_allowlist) > 0
    error_message = "The stand-in proxy needs a non-empty proxy_allowlist."
  }
}

variable "interface_endpoints" {
  description = "AWS services that get an interface endpoint when firewall_mode is true: the part of the service name after com.amazonaws.<region>."
  type        = list(string)
  nullable    = false
  default = [
    "bedrock-runtime",
    "bedrock-agentcore",
    "bedrock-agentcore-control",
    "secretsmanager",
    "kms",
    "logs",
    "monitoring",
    "ecr.api",
    "ecr.dkr",
    "sts",
    "ssm",
    "ssmmessages",
    "ecs",
    "ecs-agent",
    "ecs-telemetry",
  ]
}

variable "agentcore_az_ids" {
  description = "Availability zone ids (not names) AgentCore Browser supports in this region."
  type        = list(string)
}

# --- supplied by 00-foundation -----------------------------------------------

variable "logs_kms_key_arn" {
  description = "KMS key that encrypts the log groups."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary every role under /comparative/<env>/ must carry."
  type        = string
}
