# Plan-only tests of the module with a mocked AWS provider: no credentials, no
# state, no AWS calls. Every Conftest rule of policy/ is run against a real
# plan of this module by policy_on_plan.sh.

mock_provider "aws" {
  override_during = plan

  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }

  # Declaring a resource type here is what makes its computed attributes
  # available while planning.
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111122223333:role/comparative/unit/mock"
    }
  }

  mock_resource "aws_bedrockagentcore_api_key_credential_provider" {
    defaults = {
      credential_provider_arn = "arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default/apikeycredentialprovider/cmp-unit-brave-search"
    }
  }

  mock_resource "aws_bedrockagentcore_agent_runtime" {
    defaults = {
      agent_runtime_arn = "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/cmp_unit_agent-AbCdEfGhIj"
    }
  }

  mock_resource "aws_bedrockagentcore_browser" {
    defaults = {
      browser_id  = "cmp_unit_studio_browser-AbCdEfGhIj"
      browser_arn = "arn:aws:bedrock-agentcore:us-east-1:111122223333:browser-custom/cmp_unit_studio_browser-AbCdEfGhIj"
    }
  }
}

variables {
  env         = "unit"
  name_prefix = "cmp-unit"
  aws_region  = "us-east-1"
  account_id  = "111122223333"

  image                     = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-agent@sha256:00000000000000000000000000000000000000000000000000000000000000c1"
  network_mode              = "PUBLIC"
  runtime_security_group_id = "sg-00000000000runtime"

  # Made-up ids: the module must not care what a model is called.
  bedrock_model_arns = [
    "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.vendor.model-a-v1:0",
    "arn:aws:bedrock:us-east-1::foundation-model/vendor.model-a-v1:0",
    "arn:aws:bedrock:us-west-2::foundation-model/vendor.model-a-v1:0",
  ]
  bedrock_inference_profile_prefix = "us."

  web_search_provider   = "brave"
  web_search_secret_arn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/app-AbCdEf"

  browser_network_mode      = "VPC"
  browser_security_group_id = "sg-00000000000browser"
  browser_proxy_secret_arn  = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/browser-proxy-GhIjKl"

  subnet_ids               = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
  kms_secrets_arn          = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000002"
  permissions_boundary_arn = "arn:aws:iam::111122223333:policy/cmp-unit-workload-boundary"
}

# --- the sandbox: a PUBLIC runtime with web search, the browser in the VPC -------------

run "sandbox" {
  command = plan

  assert {
    condition = (
      aws_bedrockagentcore_agent_runtime.this.agent_runtime_name == "cmp_unit_agent" &&
      aws_bedrockagentcore_agent_runtime.this.agent_runtime_artifact[0].container_configuration[0].container_uri == var.image &&
      aws_bedrockagentcore_agent_runtime.this.protocol_configuration[0].server_protocol == "HTTP"
    )
    error_message = "the runtime is <name_prefix>_agent with dashes as underscores, runs the image by digest, and speaks HTTP"
  }
  assert {
    condition = (
      aws_bedrockagentcore_agent_runtime.this.network_configuration[0].network_mode == "PUBLIC" &&
      length(aws_bedrockagentcore_agent_runtime.this.network_configuration[0].network_mode_config) == 0
    )
    error_message = "a PUBLIC runtime has no VPC configuration"
  }
  assert {
    condition = aws_bedrockagentcore_agent_runtime.this.environment_variables == tomap({
      BEDROCK_CLIENT                   = "real"
      AWS_DEFAULT_REGION               = "us-east-1"
      WEB_SEARCH_PROVIDER              = "brave"
      BRAVE_SEARCH_CREDENTIAL_PROVIDER = "cmp-unit-brave-search"
      BEDROCK_INFERENCE_PROFILE_PREFIX = "us."
    })
    error_message = "the runtime's environment is the CDK runtime's, plus the inference-profile prefix, and no proxy"
  }
  assert {
    condition     = aws_bedrockagentcore_agent_runtime.this.role_arn == aws_iam_role.runtime.arn
    error_message = "the runtime runs with its own role"
  }

  # --- the runtime role ---
  assert {
    condition = (
      aws_iam_role.runtime.name == "cmp-unit-agent-runtime" &&
      aws_iam_role.runtime.path == "/comparative/unit/" &&
      aws_iam_role.runtime.permissions_boundary == var.permissions_boundary_arn
    )
    error_message = "the runtime role lives under /comparative/<env>/ with the workload boundary"
  }
  assert {
    condition = jsondecode(aws_iam_role.runtime.assume_role_policy).Statement == [{
      Effect    = "Allow"
      Principal = { Service = "bedrock-agentcore.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = "111122223333" }
        ArnLike      = { "aws:SourceArn" = "arn:aws:bedrock-agentcore:us-east-1:111122223333:*" }
      }
    }]
    error_message = "only AgentCore, acting for this account in this region, may assume the runtime role"
  }
  assert {
    condition = [for statement in jsondecode(aws_iam_role_policy.runtime.policy).Statement : statement.Sid] == [
      "RegistryLogin", "PullAgentImage", "InvokeModels", "WriteLogs",
    ]
    error_message = "the runtime role pulls its image, invokes the models and writes logs, and nothing else (no aws-marketplace grant)"
  }
  assert {
    condition = (
      jsondecode(aws_iam_role_policy.runtime.policy).Statement[1].Resource == "arn:aws:ecr:us-east-1:111122223333:repository/cmp-unit-agent" &&
      tolist(jsondecode(aws_iam_role_policy.runtime.policy).Statement[2].Resource) == var.bedrock_model_arns &&
      jsondecode(aws_iam_role_policy.runtime.policy).Statement[3].Resource == "arn:aws:logs:us-east-1:111122223333:log-group:/aws/bedrock-agentcore/*"
    )
    error_message = "image pull is scoped to the agent repository, model access to the listed ARNs, logs to /aws/bedrock-agentcore/"
  }
  # The rule: no Bedrock or AgentCore action of the runtime role is allowed on
  # Resource "*".
  assert {
    condition = alltrue([
      for statement in concat(
        jsondecode(aws_iam_role_policy.runtime.policy).Statement,
        jsondecode(aws_iam_role_policy.runtime_web_search[0].policy).Statement,
      ) :
      !contains(flatten([statement.Resource]), "*") || !anytrue([for action in flatten([statement.Action]) : startswith(lower(action), "bedrock")])
    ])
    error_message = "the runtime role must not allow a bedrock or bedrock-agentcore action on Resource \"*\""
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.runtime_web_search[0].policy).Statement == [{
      Sid    = "ReadWebSearchCredential"
      Effect = "Allow"
      Action = "bedrock-agentcore:GetResourceApiKey"
      Resource = [
        "arn:aws:bedrock-agentcore:us-east-1:111122223333:workload-identity-directory/default",
        "arn:aws:bedrock-agentcore:us-east-1:111122223333:workload-identity-directory/default/workload-identity/cmp_unit_agent-*",
        "arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default",
        "arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default/apikeycredentialprovider/cmp-unit-brave-search",
      ]
    }]
    error_message = "with web search the role may fetch the key through its own workload identity and the one credential provider"
  }

  # --- the credential provider ---
  assert {
    condition = (
      aws_bedrockagentcore_api_key_credential_provider.web_search[0].name == "cmp-unit-brave-search" &&
      aws_bedrockagentcore_api_key_credential_provider.web_search[0].api_key_secret_source == "EXTERNAL" &&
      aws_bedrockagentcore_api_key_credential_provider.web_search[0].api_key_secret_config[0].secret_id == var.web_search_secret_arn &&
      aws_bedrockagentcore_api_key_credential_provider.web_search[0].api_key_secret_config[0].json_key == "BRAVE_SEARCH_API_KEY" &&
      aws_bedrockagentcore_api_key_credential_provider.web_search[0].api_key == null &&
      aws_bedrockagentcore_api_key_credential_provider.web_search[0].api_key_wo == null
    )
    error_message = "the credential provider points at BRAVE_SEARCH_API_KEY of the app secret and carries no key itself"
  }

  # --- the browser ---
  assert {
    condition = (
      aws_bedrockagentcore_browser.studio.name == "cmp_unit_studio_browser" &&
      aws_bedrockagentcore_browser.studio.execution_role_arn == aws_iam_role.browser.arn &&
      aws_bedrockagentcore_browser.studio.browser_signing[0].enabled == true
    )
    error_message = "the browser is <name_prefix>_studio_browser, runs with its own role and signs its requests, as in production"
  }
  assert {
    condition = (
      aws_bedrockagentcore_browser.studio.network_configuration[0].network_mode == "VPC" &&
      aws_bedrockagentcore_browser.studio.network_configuration[0].vpc_config[0].subnets == toset(var.subnet_ids) &&
      aws_bedrockagentcore_browser.studio.network_configuration[0].vpc_config[0].security_groups == toset(["sg-00000000000browser"])
    )
    error_message = "a VPC browser sits in the agentcore subnets with the studio_browser group only"
  }
  assert {
    condition = (
      aws_iam_role.browser.path == "/comparative/unit/" &&
      aws_iam_role.browser.permissions_boundary == var.permissions_boundary_arn &&
      jsondecode(aws_iam_role.browser.assume_role_policy).Statement[0].Condition.ArnLike["aws:SourceArn"] == "arn:aws:bedrock-agentcore:us-east-1:111122223333:browser-custom/cmp_unit_studio_browser*"
    )
    error_message = "the browser role lives under /comparative/<env>/ with the boundary and trusts this browser only"
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.browser.policy).Statement == [
      {
        Sid      = "ReadBrowserProxyCredentials"
        Effect   = "Allow"
        Action   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
        Resource = var.browser_proxy_secret_arn
      },
      {
        Sid       = "DecryptBrowserProxyCredentials"
        Effect    = "Allow"
        Action    = "kms:Decrypt"
        Resource  = var.kms_secrets_arn
        Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.us-east-1.amazonaws.com" } }
      },
    ]
    error_message = "the browser role reads the browser-proxy secret and nothing else"
  }

  assert {
    condition = (
      output.runtime_arn == "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/cmp_unit_agent-AbCdEfGhIj" &&
      output.browser_id == "cmp_unit_studio_browser-AbCdEfGhIj" &&
      output.browser_arn == "arn:aws:bedrock-agentcore:us-east-1:111122223333:browser-custom/cmp_unit_studio_browser-AbCdEfGhIj"
    )
    error_message = "the outputs are the runtime's ARN and the browser's id and ARN"
  }
}

# --- firewall mode: a VPC runtime behind a proxy, without web search -------------------

run "firewall" {
  command = plan

  variables {
    network_mode        = "VPC"
    web_search_provider = "none"
    proxy_url           = "http://proxy.corp.example:3128"
    no_proxy            = "169.254.170.2,localhost,127.0.0.1"
  }

  assert {
    condition = (
      aws_bedrockagentcore_agent_runtime.this.network_configuration[0].network_mode == "VPC" &&
      aws_bedrockagentcore_agent_runtime.this.network_configuration[0].network_mode_config[0].subnets == toset(var.subnet_ids) &&
      aws_bedrockagentcore_agent_runtime.this.network_configuration[0].network_mode_config[0].security_groups == toset(["sg-00000000000runtime"])
    )
    error_message = "a VPC runtime sits in the agentcore subnets with the agent_runtime group only"
  }
  assert {
    condition = aws_bedrockagentcore_agent_runtime.this.environment_variables == tomap({
      BEDROCK_CLIENT                   = "real"
      AWS_DEFAULT_REGION               = "us-east-1"
      WEB_SEARCH_PROVIDER              = "none"
      BEDROCK_INFERENCE_PROFILE_PREFIX = "us."
      HTTPS_PROXY                      = "http://proxy.corp.example:3128"
      HTTP_PROXY                       = "http://proxy.corp.example:3128"
      NO_PROXY                         = "169.254.170.2,localhost,127.0.0.1"
    })
    error_message = "a VPC runtime gets the proxy variables, and without web search no credential provider name"
  }
  assert {
    condition = (
      length(aws_bedrockagentcore_api_key_credential_provider.web_search) == 0 &&
      length(aws_iam_role_policy.runtime_web_search) == 0
    )
    error_message = "without web search there is no credential provider and no permission to read one"
  }
}

run "public_runtime_gets_no_proxy" {
  command = plan

  variables {
    proxy_url = "http://proxy.corp.example:3128"
    no_proxy  = "169.254.170.2"
  }

  assert {
    condition     = !anytrue([for name in ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"] : contains(keys(aws_bedrockagentcore_agent_runtime.this.environment_variables), name)])
    error_message = "a PUBLIC runtime is outside the VPC and is not pointed at a proxy it cannot reach"
  }
}

run "public_browser" {
  command = plan

  variables {
    browser_network_mode = "PUBLIC"
  }

  assert {
    condition = (
      aws_bedrockagentcore_browser.studio.network_configuration[0].network_mode == "PUBLIC" &&
      length(aws_bedrockagentcore_browser.studio.network_configuration[0].vpc_config) == 0
    )
    error_message = "a PUBLIC browser has no VPC configuration"
  }
}

run "everything_public_needs_no_subnets" {
  command = plan

  variables {
    browser_network_mode = "PUBLIC"
    subnet_ids           = []
  }

  assert {
    condition     = aws_bedrockagentcore_agent_runtime.this.network_configuration[0].network_mode == "PUBLIC"
    error_message = "with both PUBLIC the module plans without subnets"
  }
}

# --- refused inputs ---------------------------------------------------------------------

run "image_by_tag_is_rejected" {
  command = plan

  variables {
    image = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-agent:agent-latest"
  }

  expect_failures = [var.image]
}

run "model_wildcard_is_rejected" {
  command = plan

  variables {
    bedrock_model_arns = ["arn:aws:bedrock:us-east-1::foundation-model/*"]
  }

  expect_failures = [var.bedrock_model_arns]
}

run "unknown_network_mode_is_rejected" {
  command = plan

  variables {
    network_mode = "SANDBOX"
  }

  expect_failures = [var.network_mode]
}

run "vpc_without_subnets_is_rejected" {
  command = plan

  variables {
    network_mode = "VPC"
    subnet_ids   = []
  }

  expect_failures = [var.subnet_ids]
}

run "unknown_web_search_provider_is_rejected" {
  command = plan

  variables {
    web_search_provider = "google"
  }

  expect_failures = [var.web_search_provider]
}
