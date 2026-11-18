# Inputs only this stack reads, plus one it shares with 40-services: web_min.

variable "alert_emails" {
  description = "Addresses subscribed to the ops alert topic. Each owner confirms the subscription from the email AWS sends."
  type        = list(string)
}

variable "web_min" {
  description = "Fewest web tasks autoscaling keeps running: the floor the web task alarm watches."
  type        = number
}

variable "quota_alarm_models" {
  description = "Bedrock models whose daily token quota is watched: the ModelId dimension of AWS/Bedrock, the account's tokens-per-day quota for it, and how many quota tokens one output token costs. The quota belongs to the account, so one environment per account lists the models and the others set []."
  type = list(object({
    model_id        = string
    daily_quota     = number
    output_burndown = number
  }))
}

# Queue depth has no alarm: the application publishes no metric for it yet.
# variable "queue_depth_alarm_threshold" {
#   description = "Queued runs at which the queue depth alarm fires."
#   type        = number
# }
