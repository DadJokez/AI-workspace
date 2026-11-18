# Common inputs. Every stack declares these five the same way; their values
# come from envs/<env>/env.tfvars.

variable "env" {
  description = "Environment name; the directory name under envs/."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+$", var.env))
    error_message = "env must be lower-case letters, digits and hyphens."
  }
}

variable "name_prefix" {
  description = "Prefix of every resource name. Always cmp-<env>."
  type        = string

  validation {
    condition     = var.name_prefix == "cmp-${var.env}"
    error_message = "name_prefix must be cmp-<env>."
  }
}

variable "aws_region" {
  description = "Home region of the environment."
  type        = string
}

variable "account_id" {
  description = "AWS account this environment belongs to. Checked against the caller's account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account id."
  }
}

variable "tags" {
  description = "Tags applied to every resource through the provider's default_tags."
  type        = map(string)

  validation {
    condition = alltrue([
      for key in ["app", "env", "owner", "cost-center", "data-class", "managed-by", "repo"] :
      try(var.tags[key], "") != ""
    ])
    error_message = "tags must set app, env, owner, cost-center, data-class, managed-by and repo."
  }
}
