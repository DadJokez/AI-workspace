# 40-services: the four ECS services of one environment. web sits behind the
# load balancer and scales on CPU; chat-worker and memory-worker run the
# background lanes; browser-proxy is the governed way out for the AgentCore
# Browser.
#
# Applied after 50-agentcore: this stack reads the runtime and the browser from
# it, and does not plan while those parameters are missing.

data "aws_partition" "current" {}

data "aws_caller_identity" "current" {
  lifecycle {
    postcondition {
      condition     = self.account_id == var.account_id
      error_message = "The credentials in use belong to another account than var.account_id."
    }
  }
}

# ARNs, ids, names and URLs, not secrets: insecure_value keeps them readable in
# the plan.

# 00-foundation
data "aws_ssm_parameter" "logs_kms_key_arn" {
  name = "/comparative/${var.env}/00-foundation/kms/logs_arn"
}

data "aws_ssm_parameter" "secrets_kms_key_arn" {
  name = "/comparative/${var.env}/00-foundation/kms/secrets_arn"
}

data "aws_ssm_parameter" "workload_boundary_arn" {
  name = "/comparative/${var.env}/00-foundation/iam/workload_boundary_arn"
}

# 10-network
data "aws_ssm_parameter" "app_subnet_ids" {
  name = "/comparative/${var.env}/10-network/app_subnet_ids"
}

data "aws_ssm_parameter" "web_security_group_id" {
  name = "/comparative/${var.env}/10-network/sg/web_id"
}

data "aws_ssm_parameter" "worker_security_group_id" {
  name = "/comparative/${var.env}/10-network/sg/worker_id"
}

data "aws_ssm_parameter" "browser_proxy_security_group_id" {
  name = "/comparative/${var.env}/10-network/sg/browser_proxy_id"
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

data "aws_ssm_parameter" "browser_proxy_db_secret_arn" {
  name = "/comparative/${var.env}/20-data/secret/browser_proxy_db_arn"
}

# 30-platform
data "aws_ssm_parameter" "cluster_arn" {
  name = "/comparative/${var.env}/30-platform/cluster_arn"
}

data "aws_ssm_parameter" "namespace_id" {
  name = "/comparative/${var.env}/30-platform/namespace_id"
}

data "aws_ssm_parameter" "web_target_group_arn" {
  name = "/comparative/${var.env}/30-platform/tg/web_arn"
}

data "aws_ssm_parameter" "base_url" {
  name = "/comparative/${var.env}/30-platform/base_url"
}

# 50-agentcore
data "aws_ssm_parameter" "runtime_arn" {
  name = "/comparative/${var.env}/50-agentcore/runtime_arn"
}

data "aws_ssm_parameter" "browser_id" {
  name = "/comparative/${var.env}/50-agentcore/browser_id"
}

data "aws_ssm_parameter" "browser_arn" {
  name = "/comparative/${var.env}/50-agentcore/browser_arn"
}

locals {
  partition  = data.aws_partition.current.partition
  account_id = data.aws_caller_identity.current.account_id

  cluster_arn  = data.aws_ssm_parameter.cluster_arn.insecure_value
  namespace_id = data.aws_ssm_parameter.namespace_id.insecure_value
  # 10-network publishes subnet lists as JSON arrays.
  app_subnet_ids = jsondecode(data.aws_ssm_parameter.app_subnet_ids.insecure_value)

  kms_logs_arn             = data.aws_ssm_parameter.logs_kms_key_arn.insecure_value
  kms_secrets_arn          = data.aws_ssm_parameter.secrets_kms_key_arn.insecure_value
  permissions_boundary_arn = data.aws_ssm_parameter.workload_boundary_arn.insecure_value

  app_secret_arn              = data.aws_ssm_parameter.app_secret_arn.insecure_value
  browser_proxy_secret_arn    = data.aws_ssm_parameter.browser_proxy_secret_arn.insecure_value
  browser_proxy_db_secret_arn = data.aws_ssm_parameter.browser_proxy_db_secret_arn.insecure_value

  runtime_arn = data.aws_ssm_parameter.runtime_arn.insecure_value
  browser_arn = data.aws_ssm_parameter.browser_arn.insecure_value

  browser_proxy_port  = 3128
  invite_email_region = coalesce(var.invite_email_aws_region, var.aws_region)

  # --- environment --------------------------------------------------------------

  # 10-network publishes an absent proxy as the word "none".
  proxy_url = data.aws_ssm_parameter.proxy_url.insecure_value
  proxy_environment = local.proxy_url == "none" ? {} : {
    HTTPS_PROXY = local.proxy_url
    HTTP_PROXY  = local.proxy_url
    NO_PROXY    = data.aws_ssm_parameter.no_proxy.insecure_value
  }

  # What web and both workers share. var.extra_environment may add to it and
  # replace a value in it; what a service sets for itself below always wins.
  common_environment = merge(
    {
      NODE_ENV                         = "production"
      AWS_REGION                       = var.aws_region
      BEDROCK_CLIENT                   = "real"
      RUNTIME                          = "bedrock"
      RUNTIME_V2_ENABLED               = "1"
      RUNTIME_V2_DIRECT_MODEL_ID       = "auto"
      NEXTAUTH_URL                     = data.aws_ssm_parameter.base_url.insecure_value
      LEGACY_HOST_REDIRECT_FROM        = var.legacy_host_redirect_from
      HOSTNAME                         = "0.0.0.0"
      PORT                             = "3000"
      BEDROCK_INFERENCE_PROFILE_PREFIX = var.bedrock_inference_profile_prefix
    },
    var.internal_base_url == "" ? {} : { INTERNAL_BASE_URL = var.internal_base_url },
    local.proxy_environment,
    var.extra_environment,
  )

  # --- secrets ------------------------------------------------------------------

  # Fields of the app secret that web and both workers read: the names
  # production uses today.
  app_secret_fields = [
    "DATABASE_URL",
    "NEXTAUTH_SECRET",
    "GITHUB_AUTH_CLIENT_ID",
    "GITHUB_AUTH_CLIENT_SECRET",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "NOTION_CLIENT_ID",
    "NOTION_CLIENT_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "SALESFORCE_CLIENT_ID",
    "SALESFORCE_CLIENT_SECRET",
    "OAUTH_ENCRYPTION_KEY",
    "WEB_SEARCH_PROVIDER",
    "BRAVE_SEARCH_API_KEY",
  ]

  # A task receives a reference, <secret arn>:<json key>::, never a value.
  common_secrets = { for field in local.app_secret_fields : field => "${local.app_secret_arn}:${field}::" }
  web_secrets = merge(
    local.common_secrets,
    { for field in concat(["GITHUB_WEBHOOK_SECRET"], var.optional_app_secret_fields) : field => "${local.app_secret_arn}:${field}::" },
  )

  # --- task-role permissions ------------------------------------------------------

  # Model access is a list of ARNs, never a wildcard: the inference profile of
  # each model in the home region, and the foundation model in every region
  # the profile routes to.
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

  statement_invoke_models = {
    Sid      = "InvokeModels"
    Effect   = "Allow"
    Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    Resource = local.bedrock_model_arns
  }

  statement_invoke_runtime = {
    Sid      = "InvokeAgentRuntime"
    Effect   = "Allow"
    Action   = ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:InvokeAgentRuntimeForUser"]
    Resource = [local.runtime_arn, "${local.runtime_arn}/*"]
  }

  web_task_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.statement_invoke_models,
      local.statement_invoke_runtime,
      {
        Sid      = "SendInviteEmail"
        Effect   = "Allow"
        Action   = "ses:SendEmail"
        Resource = "arn:${local.partition}:ses:${local.invite_email_region}:${local.account_id}:identity/${var.invite_email_identity}"
      },
      {
        Sid    = "UseStudioBrowser"
        Effect = "Allow"
        Action = [
          "bedrock-agentcore:ConnectBrowserLiveViewStream",
          "bedrock-agentcore:GetBrowserSession",
          "bedrock-agentcore:InvokeBrowser",
          "bedrock-agentcore:StartBrowserSession",
          "bedrock-agentcore:StopBrowserSession",
        ]
        Resource = local.browser_arn
      },
      {
        # StartBrowserSession checks that its caller may read the credentials
        # of every proxy the session is given.
        Sid      = "ReadBrowserProxyCredentials"
        Effect   = "Allow"
        Action   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
        Resource = local.browser_proxy_secret_arn
      },
      {
        Sid      = "DecryptBrowserProxyCredentials"
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = local.kms_secrets_arn
        Condition = {
          StringEquals = { "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com" }
        }
      },
    ]
  })

  chat_worker_task_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [local.statement_invoke_models, local.statement_invoke_runtime]
  })

  memory_worker_task_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [local.statement_invoke_models]
  })

  parameters = {
    "service/web_name"           = module.web.service_name
    "service/chat_worker_name"   = module.chat_worker.service_name
    "service/memory_worker_name" = module.memory_worker.service_name
    "service/browser_proxy_name" = module.browser_proxy.service_name
  }
}

# --- web ------------------------------------------------------------------------

module "web" {
  source = "../../modules/ecs-service"

  env         = var.env
  name_prefix = var.name_prefix
  aws_region  = var.aws_region
  name        = "web"
  cluster_arn = local.cluster_arn

  # The image's own command, node apps/web/server.js.
  image  = var.image_web
  cpu    = 512
  memory = 1024
  port   = 3000

  environment = merge(local.common_environment, {
    CHAT_RUN_IN_PROCESS_WORKER          = "0"
    MEMORY_CAPTURE_IN_PROCESS_SCHEDULER = "0"
    INVITE_EMAIL_PROVIDER               = var.invite_email_provider
    INVITE_EMAIL_FROM                   = var.invite_email_from
    INVITE_EMAIL_AWS_REGION             = local.invite_email_region
    AGENTCORE_BROWSER_ENABLED           = var.agentcore_browser_enabled ? "1" : "0"
    AGENTCORE_BROWSER_ID                = data.aws_ssm_parameter.browser_id.insecure_value
    AGENTCORE_BROWSER_PROXY_HOST        = "browser-proxy.${var.internal_namespace}"
    AGENTCORE_BROWSER_PROXY_PORT        = tostring(local.browser_proxy_port)
    AGENTCORE_BROWSER_PROXY_SECRET_ARN  = local.browser_proxy_secret_arn
    STUDIO_SANDBOX_DNS_SUFFIX           = ".${var.internal_namespace}"
  })
  secrets               = local.web_secrets
  execution_secret_arns = [local.app_secret_arn]
  task_policy_json      = local.web_task_policy

  subnet_ids         = local.app_subnet_ids
  security_group_ids = [data.aws_ssm_parameter.web_security_group_id.insecure_value]

  autoscaling = {
    min        = var.web_min
    max        = var.web_max
    cpu_target = 60
  }
  load_balancer = {
    target_group_arn = data.aws_ssm_parameter.web_target_group_arn.insecure_value
  }
  min_healthy_percent = 100

  log_group_name           = "/comparative/${var.env}/web"
  kms_logs_arn             = local.kms_logs_arn
  kms_secrets_arn          = local.kms_secrets_arn
  permissions_boundary_arn = local.permissions_boundary_arn
}

# --- chat-worker ------------------------------------------------------------------

# Durable chat, skills and scheduled runs execute on the AgentCore runtime.
module "chat_worker" {
  source = "../../modules/ecs-service"

  env         = var.env
  name_prefix = var.name_prefix
  aws_region  = var.aws_region
  name        = "chat-worker"
  cluster_arn = local.cluster_arn

  image   = var.image_worker
  command = ["pnpm", "--filter", "@ai-workspace/web", "worker:chat-runs"]
  cpu     = 256
  memory  = 512

  environment = merge(local.common_environment, {
    RUNTIME                             = "agentcore"
    AGENTCORE_RUNTIME_ARN               = local.runtime_arn
    MEMORY_CAPTURE_IN_PROCESS_SCHEDULER = "0"
  })
  secrets               = local.common_secrets
  execution_secret_arns = [local.app_secret_arn]
  task_policy_json      = local.chat_worker_task_policy

  subnet_ids         = local.app_subnet_ids
  security_group_ids = [data.aws_ssm_parameter.worker_security_group_id.insecure_value]

  desired_count       = var.chat_worker_count
  min_healthy_percent = 0

  log_group_name           = "/comparative/${var.env}/chat-worker"
  kms_logs_arn             = local.kms_logs_arn
  kms_secrets_arn          = local.kms_secrets_arn
  permissions_boundary_arn = local.permissions_boundary_arn
}

# --- memory-worker ----------------------------------------------------------------

module "memory_worker" {
  source = "../../modules/ecs-service"

  env         = var.env
  name_prefix = var.name_prefix
  aws_region  = var.aws_region
  name        = "memory-worker"
  cluster_arn = local.cluster_arn

  image   = var.image_memory_worker
  command = ["pnpm", "--filter", "@ai-workspace/web", "worker:memory-capture"]
  cpu     = 256
  memory  = 512

  environment = merge(local.common_environment, {
    MEMORY_CAPTURE_IN_PROCESS_SCHEDULER = "0"
  })
  secrets               = local.common_secrets
  execution_secret_arns = [local.app_secret_arn]
  task_policy_json      = local.memory_worker_task_policy

  subnet_ids         = local.app_subnet_ids
  security_group_ids = [data.aws_ssm_parameter.worker_security_group_id.insecure_value]

  desired_count       = 1
  min_healthy_percent = 0

  log_group_name           = "/comparative/${var.env}/memory-worker"
  kms_logs_arn             = local.kms_logs_arn
  kms_secrets_arn          = local.kms_secrets_arn
  permissions_boundary_arn = local.permissions_boundary_arn
}

# --- browser-proxy ----------------------------------------------------------------

# The AgentCore Browser's only way out. It reads the egress policy with a
# database login of its own and never receives the app secret, the common
# environment or any AWS permission.
module "browser_proxy" {
  source = "../../modules/ecs-service"

  env         = var.env
  name_prefix = var.name_prefix
  aws_region  = var.aws_region
  name        = "browser-proxy"
  cluster_arn = local.cluster_arn

  image   = var.image_worker
  command = ["pnpm", "--filter", "@ai-workspace/web", "browser:egress-proxy"]
  cpu     = 256
  memory  = 512
  port    = local.browser_proxy_port

  environment = {
    NODE_ENV           = "production"
    AWS_REGION         = var.aws_region
    BROWSER_PROXY_PORT = tostring(local.browser_proxy_port)
  }
  secrets = {
    DATABASE_URL           = "${local.browser_proxy_db_secret_arn}:DATABASE_URL::"
    BROWSER_PROXY_USERNAME = "${local.browser_proxy_secret_arn}:username::"
    BROWSER_PROXY_PASSWORD = "${local.browser_proxy_secret_arn}:password::"
  }
  execution_secret_arns = [local.browser_proxy_db_secret_arn, local.browser_proxy_secret_arn]

  # The port accepts a TCP connection.
  health_check = {
    command = [
      "CMD-SHELL",
      "node -e \"const s=require('net').connect(${local.browser_proxy_port},'127.0.0.1');s.setTimeout(2000);s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1))\"",
    ]
    interval     = 30
    timeout      = 5
    retries      = 3
    start_period = 15
  }

  subnet_ids         = local.app_subnet_ids
  security_group_ids = [data.aws_ssm_parameter.browser_proxy_security_group_id.insecure_value]

  desired_count       = 1
  min_healthy_percent = 100
  service_registry = {
    namespace_id = local.namespace_id
    name         = "browser-proxy"
  }

  log_group_name           = "/comparative/${var.env}/browser-proxy"
  kms_logs_arn             = local.kms_logs_arn
  kms_secrets_arn          = local.kms_secrets_arn
  permissions_boundary_arn = local.permissions_boundary_arn
}

# --- Published outputs -------------------------------------------------------

# Downstream stacks read these with aws_ssm_parameter data sources; there is no
# terraform_remote_state. Service names, not secrets.
resource "aws_ssm_parameter" "published" {
  #checkov:skip=CKV2_AWS_34:Service names, not secrets; plain String so any downstream stack can read them
  for_each = local.parameters

  name  = "/comparative/${var.env}/40-services/${each.key}"
  type  = "String"
  value = each.value
}
