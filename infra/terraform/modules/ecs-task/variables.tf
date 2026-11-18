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

variable "name" {
  description = "Name of the workload, for example \"web\". It names the container, the task family and the two roles."
  type        = string
}

variable "image" {
  description = "Container image in an ECR repository, by digest: <account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<digest>."
  type        = string

  # A tag can be moved to another image; a digest cannot. The repository part
  # is read to scope the execution role's pull permission.
  validation {
    condition     = can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com(\\.cn)?/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$", var.image))
    error_message = "image must name an ECR image by digest (<account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<64 hex digits>); a tag is not accepted."
  }
}

variable "command" {
  description = "Command of the container; null runs the image's own."
  type        = list(string)
  default     = null
}

variable "cpu" {
  description = "Fargate CPU units of the task."
  type        = number
}

variable "memory" {
  description = "Fargate memory of the task in MiB."
  type        = number
}

variable "port" {
  description = "TCP port the container listens on; null when it listens on none."
  type        = number
  default     = null
}

variable "environment" {
  description = "Environment variables of the container. Never secret values."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Secrets of the container: variable name to a Secrets Manager valueFrom (<secret arn>:<json key>::)."
  type        = map(string)
  default     = {}
}

variable "execution_secret_arns" {
  description = "ARNs of the secrets named in var.secrets; the execution role may read exactly these."
  type        = list(string)
  default     = []
}

variable "task_policy_json" {
  description = "Policy of the task role as JSON; null gives the task no AWS permissions."
  type        = string
  default     = null
}

variable "log_group_name" {
  description = "Name of the task's log group, /comparative/<env>/<service>."
  type        = string
}

variable "kms_logs_arn" {
  description = "KMS key that encrypts the log group."
  type        = string
}

variable "kms_secrets_arn" {
  description = "KMS key that encrypts the secrets in var.execution_secret_arns."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary of the two roles: the workload boundary of 00-foundation."
  type        = string
}

variable "health_check" {
  description = "Container health check, or null for none. Times are in seconds."
  type = object({
    command      = list(string)
    interval     = number
    timeout      = number
    retries      = number
    start_period = number
  })
  default = null
}

variable "cpu_architecture" {
  description = "CPU architecture the image is built for: X86_64 or ARM64."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}
