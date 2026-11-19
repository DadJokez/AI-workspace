# 50-agentcore: the AgentCore runtime of the durable agent lane, its role and
# web-search credential provider, and the Studio Browser.
#
# Applied after 35-deploy-tasks and before 40-services, which reads the
# runtime and the browser from the parameters this stack publishes.

data "aws_partition" "current" {}

data "aws_caller_identity" "current" {
  lifecycle {
    postcondition {
      condition     = self.account_id == var.account_id
      error_message = "The credentials in use belong to another account than var.account_id."
    }
  }
}

# ARNs, ids and URLs, not secrets: insecure_value keeps them readable in the
# plan.

# 00-foundation
data "aws_ssm_parameter" "secrets_kms_key_arn" {
  name = "/comparative/${var.env}/00-foundation/kms/secrets_arn"
}

data "aws_ssm_parameter" "workload_boundary_arn" {
  name = "/comparative/${var.env}/00-foundation/iam/workload_boundary_arn"
}

# 10-network
data "aws_ssm_parameter" "agentcore_subnet_ids" {
  name = "/comparative/${var.env}/10-network/agentcore_subnet_ids"
}

data "aws_ssm_parameter" "agent_runtime_security_group_id" {
  name = "/comparative/${var.env}/10-network/sg/agent_runtime_id"
}

data "aws_ssm_parameter" "studio_browser_security_group_id" {
  name = "/comparative/${var.env}/10-network/sg/studio_browser_id"
}

data "aws_ssm_parameter" "proxy_url" {
  name = "/comparative/${var.env}/10-network/proxy_url"
}

data "aws_ssm_parameter" "no_proxy" {
  name = "/comparative/${var.env}/10-network/no_proxy"
}

# 20-data
data "aws_ssm_parameter" "app_secret_arn" {
  name = "/comparative/${var.env}/20-data/secret/app_arn"
}

data "aws_ssm_parameter" "browser_proxy_secret_arn" {
  name = "/comparative/${var.env}/20-data/secret/browser_proxy_arn"
}

locals {
  partition  = data.aws_partition.current.partition
  account_id = data.aws_caller_identity.current.account_id

  # Model access is a list of ARNs, never a wildcard: the same models, and
  # the same ARNs, as the services of 40-services may invoke.
  bedrock_model_arns = concat(
    var.bedrock_inference_profile_prefix == "" ? [] : [
      for id in var.bedrock_model_ids :
      "arn:${local.partition}:bedrock:${var.aws_region}:${local.account_id}:inference-profile/${var.bedrock_inference_profile_prefix}${id}"
    ],
    flatten([
      for region in var.bedrock_inference_regions : [
        for id in var.bedrock_model_ids :
        "arn:${local.partition}:bedrock:${region}::foundation-model/${id}"
      ]
    ]),
  )

  # 10-network publishes an absent proxy as the word "none".
  proxy_url = data.aws_ssm_parameter.proxy_url.insecure_value

  parameters = {
    "runtime_arn" = module.agentcore.runtime_arn
    "browser_id"  = module.agentcore.browser_id
    "browser_arn" = module.agentcore.browser_arn
  }
}

module "agentcore" {
  source = "../../modules/agentcore"

  env         = var.env
  name_prefix = var.name_prefix
  aws_region  = var.aws_region
  account_id  = local.account_id

  image                     = var.image_agent
  network_mode              = var.agentcore_network_mode
  runtime_security_group_id = data.aws_ssm_parameter.agent_runtime_security_group_id.insecure_value

  bedrock_model_arns               = local.bedrock_model_arns
  bedrock_inference_profile_prefix = var.bedrock_inference_profile_prefix

  web_search_provider   = var.agentcore_web_search_provider
  web_search_secret_arn = data.aws_ssm_parameter.app_secret_arn.insecure_value

  proxy_url = local.proxy_url == "none" ? "" : local.proxy_url
  no_proxy  = data.aws_ssm_parameter.no_proxy.insecure_value

  browser_network_mode      = var.agentcore_browser_network_mode
  browser_security_group_id = data.aws_ssm_parameter.studio_browser_security_group_id.insecure_value
  browser_proxy_secret_arn  = data.aws_ssm_parameter.browser_proxy_secret_arn.insecure_value

  # 10-network publishes subnet lists as JSON arrays.
  subnet_ids               = jsondecode(data.aws_ssm_parameter.agentcore_subnet_ids.insecure_value)
  kms_secrets_arn          = data.aws_ssm_parameter.secrets_kms_key_arn.insecure_value
  permissions_boundary_arn = data.aws_ssm_parameter.workload_boundary_arn.insecure_value
}

# --- Published outputs -------------------------------------------------------

# 40-services reads these with aws_ssm_parameter data sources; there is no
# terraform_remote_state. Two ARNs and an id, not secrets.
resource "aws_ssm_parameter" "published" {
  #checkov:skip=CKV2_AWS_34:ARNs and an id, not secrets; plain String so any downstream stack can read them
  for_each = local.parameters

  name  = "/comparative/${var.env}/50-agentcore/${each.key}"
  type  = "String"
  value = each.value
}
