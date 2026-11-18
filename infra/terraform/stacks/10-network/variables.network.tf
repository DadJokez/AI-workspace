# Inputs only this stack reads. Each is passed to modules/network unchanged;
# the module validates them and their combinations.

variable "network_mode" {
  description = "\"create\" builds a VPC; \"adopt\" uses the VPC and subnets a landing zone supplies."
  type        = string
}

variable "vpc_cidr" {
  description = "Create mode: IPv4 CIDR of the VPC, a /16."
  type        = string
  default     = null
}

variable "az_count" {
  description = "Create mode: number of availability zones."
  type        = number
  default     = 2
}

variable "vpc_id" {
  description = "Adopt mode: id of the landing zone's VPC."
  type        = string
  default     = null
}

variable "app_subnet_ids" {
  description = "Adopt mode: subnets for the services."
  type        = list(string)
  default     = []
}

variable "data_subnet_ids" {
  description = "Adopt mode: subnets for the database."
  type        = list(string)
  default     = []
}

variable "public_subnet_ids" {
  description = "Adopt mode: subnets for a public load balancer."
  type        = list(string)
  default     = []
}

variable "firewall_mode" {
  description = "True = no internet route from the app subnets; AWS APIs are reached through interface endpoints."
  type        = bool
}

# policy/sg_no_open_ingress.rego reads this variable by name from the plan.
variable "internal_alb" {
  description = "True = the load balancer is internal."
  type        = bool
}

variable "alb_ingress_cidrs" {
  description = "IPv4 ranges that may reach the load balancer. 0.0.0.0/0 is accepted only when internal_alb is false."
  type        = list(string)
}

variable "egress" {
  description = "\"nat\" = one NAT gateway (sandbox). \"proxy\" = no default route; outbound traffic goes through the proxy only."
  type        = string
}

variable "proxy_url" {
  description = "URL of the organisation's forward proxy, http://host:port."
  type        = string
  default     = ""
}

variable "proxy_cidrs" {
  description = "IPv4 ranges the proxy at proxy_url answers from."
  type        = list(string)
  default     = []
}

variable "create_standin_proxy" {
  description = "Build the stand-in forward proxy. Rehearsal environments only."
  type        = bool
  default     = false
}

variable "proxy_allowlist" {
  description = "Hosts the stand-in proxy lets through."
  type        = list(string)
  default     = []
}

variable "interface_endpoints" {
  description = "AWS services that get an interface endpoint in firewall mode. Null takes the module's list."
  type        = list(string)
  default     = null
}

variable "agentcore_az_ids" {
  description = "Availability zone ids AgentCore Browser supports in this region."
  type        = list(string)
}
