# 10-network: the VPC (built or adopted), its endpoints, the security groups of
# every workload, and the optional stand-in proxy of a rehearsal environment.

# An ARN, not a secret: insecure_value keeps it readable in the plan.
data "aws_ssm_parameter" "logs_kms_key_arn" {
  name = "/comparative/${var.env}/00-foundation/kms/logs_arn"
}

data "aws_ssm_parameter" "workload_boundary_arn" {
  name = "/comparative/${var.env}/00-foundation/iam/workload_boundary_arn"
}

locals {
  # SSM cannot store an empty value. Lists are published as JSON (an empty list
  # is "[]"), and an absent proxy as the word "none".
  parameters = merge(
    {
      "vpc_id"               = module.network.vpc_id
      "app_subnet_ids"       = jsonencode(module.network.app_subnet_ids)
      "data_subnet_ids"      = jsonencode(module.network.data_subnet_ids)
      "public_subnet_ids"    = jsonencode(module.network.public_subnet_ids)
      "agentcore_subnet_ids" = jsonencode(module.network.agentcore_subnet_ids)
      "proxy_url"            = module.network.proxy_url == "" ? "none" : module.network.proxy_url
      "no_proxy"             = module.network.no_proxy
    },
    { for name, id in module.network.security_group_ids : "sg/${name}_id" => id },
  )
}

module "network" {
  source = "../../modules/network"

  env         = var.env
  name_prefix = var.name_prefix
  aws_region  = var.aws_region

  mode     = var.network_mode
  vpc_cidr = var.vpc_cidr
  az_count = var.az_count

  vpc_id            = var.vpc_id
  app_subnet_ids    = var.app_subnet_ids
  data_subnet_ids   = var.data_subnet_ids
  public_subnet_ids = var.public_subnet_ids

  firewall_mode     = var.firewall_mode
  internal_alb      = var.internal_alb
  alb_ingress_cidrs = var.alb_ingress_cidrs

  egress               = var.egress
  proxy_url            = var.proxy_url
  proxy_cidrs          = var.proxy_cidrs
  create_standin_proxy = var.create_standin_proxy
  proxy_allowlist      = var.proxy_allowlist

  interface_endpoints = var.interface_endpoints
  agentcore_az_ids    = var.agentcore_az_ids

  logs_kms_key_arn         = data.aws_ssm_parameter.logs_kms_key_arn.insecure_value
  permissions_boundary_arn = data.aws_ssm_parameter.workload_boundary_arn.insecure_value
}

# --- Published outputs -------------------------------------------------------

# Downstream stacks read these with aws_ssm_parameter data sources; there is no
# terraform_remote_state. The values are ids and host names, not secrets.
resource "aws_ssm_parameter" "published" {
  #checkov:skip=CKV2_AWS_34:Ids and host names, not secrets; plain String so any downstream stack can read them
  for_each = local.parameters

  name  = "/comparative/${var.env}/10-network/${each.key}"
  type  = "String"
  value = each.value
}
