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
  description = "Name of the service, for example \"web\". The ECS service is <name_prefix>-<name>."
  type        = string
}

variable "cluster_arn" {
  description = "ARN of the ECS cluster."
  type        = string
}

# --- the task; passed to modules/ecs-task unchanged ------------------------------

variable "image" {
  description = "Container image in an ECR repository, by digest: <account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<digest>."
  type        = string

  # The same rule as modules/ecs-task, stated here as well so that a service
  # given a tag is refused at this module's own input.
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
  description = "Name of the service's log group, /comparative/<env>/<service>."
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
}

# --- the service ----------------------------------------------------------------

variable "subnet_ids" {
  description = "Private subnets of the tasks."
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security groups of the tasks."
  type        = list(string)
}

variable "desired_count" {
  description = "Number of tasks. Unused when autoscaling is set: the service then starts at autoscaling.min."
  type        = number
  default     = 1
}

variable "autoscaling" {
  description = "CPU target tracking between min and max tasks, or null for a fixed desired_count. Cooldowns are in seconds."
  type = object({
    min                = number
    max                = number
    cpu_target         = number
    scale_out_cooldown = optional(number, 60)
    scale_in_cooldown  = optional(number, 300)
  })
  default = null
}

variable "load_balancer" {
  description = "Target group the service registers var.port with, or null."
  type = object({
    target_group_arn = string
  })
  default = null

  validation {
    condition     = var.load_balancer == null || var.port != null
    error_message = "A service behind a load balancer needs a port."
  }
}

variable "service_registry" {
  description = "Cloud Map name the tasks are registered under, <name>.<namespace>, or null."
  type = object({
    namespace_id = string
    name         = string
  })
  default = null
}

variable "min_healthy_percent" {
  description = "Share of desired tasks that must stay healthy during a deployment. 0 lets a single-task service stop the old task first."
  type        = number
  default     = 100
}
