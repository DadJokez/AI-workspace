# Inputs only this stack reads, plus three it shares: internal_alb (also read
# by 10-network), and internal_namespace and domain_name (also read by
# 40-services).

variable "container_insights" {
  description = "Turn on CloudWatch Container Insights for the cluster. It is charged per metric."
  type        = bool
  default     = false
}

variable "internal_namespace" {
  description = "Name of the Cloud Map private DNS namespace; services are reached as <service>.<namespace>."
  type        = string
}

# policy/sg_no_open_ingress.rego reads this variable by name from the plan.
variable "internal_alb" {
  description = "True = the load balancer is internal: it sits in the app subnets and has no HTTP listener."
  type        = bool
}

variable "alb_deletion_protection" {
  description = "Refuse to delete the load balancer. On everywhere except an environment that is rebuilt often."
  type        = bool
}

variable "domain_name" {
  description = "DNS name users reach the application at. The base URL is https://<domain_name>."
  type        = string
}

variable "certificate_arn" {
  description = "ARN of an existing ACM certificate for domain_name. Null requests one here, validated through route53_zone_id."
  type        = string
  default     = null

  validation {
    condition     = var.certificate_arn != null || var.route53_zone_id != null
    error_message = "Set certificate_arn, or route53_zone_id so that a certificate can be requested and validated."
  }
}

variable "route53_zone_id" {
  description = "Id of the Route 53 hosted zone of domain_name. When set, this stack creates the alias record for the load balancer and, without certificate_arn, the certificate. Null leaves DNS to its owner."
  type        = string
  default     = null
}

variable "waf_acl_arn" {
  description = "ARN of a regional WAFv2 web ACL to associate with the load balancer; null for none."
  type        = string
  default     = null
}
