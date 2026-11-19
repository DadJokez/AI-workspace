# The AgentCore runtime that runs the durable agent lane (apps/agentcore-agent),
# its execution role, the optional Brave credential provider, and the Studio
# Browser with its execution role.
#
# Policies are written with jsonencode from inputs, so every document but the
# web-search one (which names the credential provider's ARN) is known at plan
# time: `terraform test` can assert on it and the Conftest rules can read it
# in the plan JSON.

data "aws_partition" "current" {}

locals {
  partition = data.aws_partition.current.partition
  arn_base  = "arn:${local.partition}:bedrock-agentcore:${var.aws_region}:${var.account_id}"

  # AgentCore names allow letters, digits and underscores only.
  runtime_name = replace("${var.name_prefix}_agent", "-", "_")
  browser_name = replace("${var.name_prefix}_studio_browser", "-", "_")

  web_search                  = var.web_search_provider == "brave"
  web_search_credential_name  = "${var.name_prefix}-brave-search"
  workload_identity_directory = "${local.arn_base}:workload-identity-directory/default"

  # <account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<digest>.
  # An image the validation of var.image rejects yields no parts, so that the
  # validation message is the only error.
  image_parts = try(
    regex("^(?P<account>[0-9]+)\\.dkr\\.ecr\\.(?P<region>[a-z0-9-]+)\\.[a-z.]+/(?P<repository>[^@]+)@", var.image),
    { account = "", region = "", repository = "" },
  )
  repository_arn = join(":", [
    "arn", local.partition, "ecr", local.image_parts.region, local.image_parts.account,
    "repository/${local.image_parts.repository}",
  ])

  # A runtime in AgentCore's own network cannot reach a proxy inside the VPC.
  proxy_environment = var.network_mode == "VPC" && var.proxy_url != "" ? {
    HTTPS_PROXY = var.proxy_url
    HTTP_PROXY  = var.proxy_url
    NO_PROXY    = var.no_proxy
  } : {}

  runtime_environment = merge(
    {
      BEDROCK_CLIENT = "real"
      # The agent's Bedrock client reads AWS_REGION ?? AWS_DEFAULT_REGION; the
      # runtime is not documented to inject AWS_REGION.
      AWS_DEFAULT_REGION               = var.aws_region
      WEB_SEARCH_PROVIDER              = var.web_search_provider
      BEDROCK_INFERENCE_PROFILE_PREFIX = var.bedrock_inference_profile_prefix
    },
    # The agent offers web search only when this names a credential provider.
    local.web_search ? { BRAVE_SEARCH_CREDENTIAL_PROVIDER = local.web_search_credential_name } : {},
    local.proxy_environment,
  )

  # Both roles are assumed by AgentCore on behalf of this account only.
  assume_role_policy = {
    runtime = jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Effect    = "Allow"
        Principal = { Service = "bedrock-agentcore.amazonaws.com" }
        Action    = "sts:AssumeRole"
        Condition = {
          StringEquals = { "aws:SourceAccount" = var.account_id }
          ArnLike      = { "aws:SourceArn" = "${local.arn_base}:*" }
        }
      }]
    })
    browser = jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Effect    = "Allow"
        Principal = { Service = "bedrock-agentcore.amazonaws.com" }
        Action    = "sts:AssumeRole"
        Condition = {
          StringEquals = { "aws:SourceAccount" = var.account_id }
          ArnLike      = { "aws:SourceArn" = "${local.arn_base}:browser-custom/${local.browser_name}*" }
        }
      }]
    })
  }
}

# --- runtime role -----------------------------------------------------------------

resource "aws_iam_role" "runtime" {
  name                 = "${var.name_prefix}-agent-runtime"
  path                 = "/comparative/${var.env}/"
  description          = "Execution role of the AgentCore runtime ${local.runtime_name}."
  permissions_boundary = var.permissions_boundary_arn
  assume_role_policy   = local.assume_role_policy.runtime
}

# What the runtime needs to start and to run the agent loop. No
# aws-marketplace grant: the CDK runtime role carries one, and the workload
# boundary allows none.
resource "aws_iam_role_policy" "runtime" {
  name = "agent-runtime"
  role = aws_iam_role.runtime.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # ecr:GetAuthorizationToken does not support resource-level permissions.
        Sid      = "RegistryLogin"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid      = "PullAgentImage"
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = local.repository_arn
      },
      {
        # A list of model and inference-profile ARNs, never "*".
        Sid      = "InvokeModels"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = var.bedrock_model_arns
      },
      {
        # AgentCore creates the runtime's log groups under this prefix.
        Sid    = "WriteLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
          "logs:PutLogEvents",
        ]
        Resource = "arn:${local.partition}:logs:${var.aws_region}:${var.account_id}:log-group:/aws/bedrock-agentcore/*"
      },
    ]
  })
}

# Only with web search: the agent fetches the Brave key through AgentCore
# Identity with the caller's workload access token.
resource "aws_iam_role_policy" "runtime_web_search" {
  count = local.web_search ? 1 : 0

  name = "web-search-credential"
  role = aws_iam_role.runtime.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "ReadWebSearchCredential"
      Effect = "Allow"
      Action = "bedrock-agentcore:GetResourceApiKey"
      Resource = [
        local.workload_identity_directory,
        # AgentCore names the runtime's workload identity <runtime name>-<suffix>.
        "${local.workload_identity_directory}/workload-identity/${local.runtime_name}-*",
        "${local.arn_base}:token-vault/default",
        aws_bedrockagentcore_api_key_credential_provider.web_search[0].credential_provider_arn,
      ]
    }]
  })
}

# --- web search credential ----------------------------------------------------------

# The key stays in the app secret (field BRAVE_SEARCH_API_KEY); the provider
# points at it and Terraform never reads the value.
resource "aws_bedrockagentcore_api_key_credential_provider" "web_search" {
  count = local.web_search ? 1 : 0

  name                  = local.web_search_credential_name
  api_key_secret_source = "EXTERNAL"

  api_key_secret_config {
    secret_id = var.web_search_secret_arn
    json_key  = "BRAVE_SEARCH_API_KEY"
  }
}

# --- runtime --------------------------------------------------------------------------

# The application invokes the runtime's DEFAULT endpoint (it sends a
# qualifier only when AGENTCORE_QUALIFIER is set, and no service sets it),
# which AgentCore keeps on the latest version. No endpoint resource, then.
resource "aws_bedrockagentcore_agent_runtime" "this" {
  agent_runtime_name = local.runtime_name
  description        = "Comparative agent loop (apps/agentcore-agent) for ${var.env}."
  role_arn           = aws_iam_role.runtime.arn

  agent_runtime_artifact {
    container_configuration {
      container_uri = var.image
    }
  }

  network_configuration {
    network_mode = var.network_mode

    dynamic "network_mode_config" {
      for_each = var.network_mode == "VPC" ? [1] : []
      content {
        subnets         = var.subnet_ids
        security_groups = [var.runtime_security_group_id]
      }
    }
  }

  protocol_configuration {
    server_protocol = "HTTP"
  }

  environment_variables = local.runtime_environment

  # The runtime pulls its image with the role when it is created.
  depends_on = [aws_iam_role_policy.runtime]
}

# --- Studio Browser -------------------------------------------------------------------

resource "aws_iam_role" "browser" {
  name                 = "${var.name_prefix}-studio-browser"
  path                 = "/comparative/${var.env}/"
  description          = "Execution role of the AgentCore Browser ${local.browser_name}."
  permissions_boundary = var.permissions_boundary_arn
  assume_role_policy   = local.assume_role_policy.browser
}

# A session presents the browser proxy's credentials, which the browser reads
# with this role when the session starts.
resource "aws_iam_role_policy" "browser" {
  name = "browser-proxy-credentials"
  role = aws_iam_role.browser.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadBrowserProxyCredentials"
        Effect   = "Allow"
        Action   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
        Resource = var.browser_proxy_secret_arn
      },
      {
        Sid      = "DecryptBrowserProxyCredentials"
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = var.kms_secrets_arn
        Condition = {
          StringEquals = { "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com" }
        }
      },
    ]
  })
}

resource "aws_bedrockagentcore_browser" "studio" {
  name               = local.browser_name
  description        = "Isolated browser for Comparative Contribution Studio (${var.env})."
  execution_role_arn = aws_iam_role.browser.arn

  network_configuration {
    network_mode = var.browser_network_mode

    dynamic "vpc_config" {
      for_each = var.browser_network_mode == "VPC" ? [1] : []
      content {
        subnets         = var.subnet_ids
        security_groups = [var.browser_security_group_id]
      }
    }
  }

  browser_signing {
    enabled = true
  }

  depends_on = [aws_iam_role_policy.browser]
}
