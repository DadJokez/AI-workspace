variable "env" {
  description = "Environment name."
  type        = string
}

variable "name_prefix" {
  description = "Prefix of every resource name, cmp-<env>."
  type        = string
}

variable "aws_region" {
  description = "Home region of the environment; the dashboard reads its metrics there."
  type        = string
}

# --- the topic ------------------------------------------------------------------

variable "kms_key_arn" {
  description = "KMS key that encrypts the ops alert topic. Its policy must let cloudwatch.amazonaws.com use it for this topic, or no alarm is delivered."
  type        = string
}

variable "alert_emails" {
  description = "Addresses subscribed to the ops alert topic. Each owner confirms the subscription from the email AWS sends."
  type        = list(string)

  # An alarm nobody receives is not an alarm.
  validation {
    condition     = length(var.alert_emails) > 0
    error_message = "alert_emails must name at least one address."
  }
}

# --- what is watched ------------------------------------------------------------

variable "cluster_name" {
  description = "Name of the ECS cluster."
  type        = string
}

variable "service_names" {
  description = "Names of the four ECS services."
  type = object({
    web           = string
    chat_worker   = string
    memory_worker = string
    browser_proxy = string
  })
}

variable "alb_arn_suffix" {
  description = "ARN suffix of the load balancer: the LoadBalancer dimension of its metrics."
  type        = string
}

variable "web_target_group_arn_suffix" {
  description = "ARN suffix of the web target group: the TargetGroup dimension of its metrics."
  type        = string
}

variable "chat_worker_log_group_name" {
  description = "Log group of the chat worker."
  type        = string
}

variable "memory_worker_log_group_name" {
  description = "Log group of the memory worker."
  type        = string
}

variable "web_min" {
  description = "Fewest web tasks autoscaling keeps running: the floor the web task alarm watches."
  type        = number
}

variable "quota_alarm_models" {
  description = "Bedrock models whose daily token quota is watched. model_id is the ModelId dimension of AWS/Bedrock (the inference profile id when one is used), daily_quota the account's tokens-per-day quota for it, output_burndown how many quota tokens one output token costs."
  type = list(object({
    model_id        = string
    daily_quota     = number
    output_burndown = number
  }))
}
