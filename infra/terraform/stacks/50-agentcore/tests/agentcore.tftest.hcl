# Tests of the stack against a mocked AWS provider: no credentials, no real
# state, no AWS calls. What the earlier stacks publish is supplied here.
#
# The first run applies against the mock, so that the runs after it plan
# against a state: "release" is then the plan of a routine deploy. A test file
# can only assert on what the root module sees. What the module plans inside
# from these values, and which resources a release touches, is checked by
# agentcore.sh, which reads the plans these runs produce; the module itself is
# tested in ../../modules/agentcore.

mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111122223333"
    }
  }

  # The values the first run's apply gives the computed attributes.
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

# --- 00-foundation ---------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.secrets_kms_key_arn
  values = { insecure_value = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000002" }
}

override_data {
  target = data.aws_ssm_parameter.workload_boundary_arn
  values = { insecure_value = "arn:aws:iam::111122223333:policy/cmp-unit-workload-boundary" }
}

# --- 10-network -------------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.agentcore_subnet_ids
  values = { insecure_value = "[\"subnet-0aaaaaaaaaaaaaaaa\",\"subnet-0bbbbbbbbbbbbbbbb\"]" }
}

override_data {
  target = data.aws_ssm_parameter.agent_runtime_security_group_id
  values = { insecure_value = "sg-00000000000runtime" }
}

override_data {
  target = data.aws_ssm_parameter.studio_browser_security_group_id
  values = { insecure_value = "sg-00000000000browser" }
}

override_data {
  target = data.aws_ssm_parameter.proxy_url
  values = { insecure_value = "none" }
}

override_data {
  target = data.aws_ssm_parameter.no_proxy
  values = { insecure_value = "169.254.170.2,localhost,127.0.0.1" }
}

# --- 20-data ----------------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.app_secret_arn
  values = { insecure_value = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/app-AbCdEf" }
}

override_data {
  target = data.aws_ssm_parameter.browser_proxy_secret_arn
  values = { insecure_value = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/browser-proxy-GhIjKl" }
}

variables {
  env         = "unit"
  name_prefix = "cmp-unit"
  aws_region  = "us-east-1"
  account_id  = "111122223333"
  tags = {
    "app"         = "comparative"
    "env"         = "unit"
    "owner"       = "platform"
    "cost-center" = "none"
    "data-class"  = "internal"
    "managed-by"  = "terraform"
    "repo"        = "example-owner/example-repo"
  }

  image_agent = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-agent@sha256:00000000000000000000000000000000000000000000000000000000000000c1"

  agentcore_network_mode         = "PUBLIC"
  agentcore_browser_network_mode = "VPC"
  agentcore_web_search_provider  = "brave"

  # Made-up ids: the stack must not care what a model is called.
  bedrock_model_ids                = ["vendor.model-a-v1:0", "vendor.model-b"]
  bedrock_inference_profile_prefix = "us."
  bedrock_inference_regions        = ["us-east-1", "us-east-2", "us-west-2"]
}

# --- the sandbox: personal-stage's profile ------------------------------------------

run "sandbox" {
  command = apply

  assert {
    condition     = toset(keys(aws_ssm_parameter.published)) == toset(["runtime_arn", "browser_id", "browser_arn"])
    error_message = "the stack publishes the runtime's ARN and the browser's id and ARN"
  }
  # The names 40-services reads; its own test asserts the same names.
  assert {
    condition = (
      aws_ssm_parameter.published["runtime_arn"].name == "/comparative/unit/50-agentcore/runtime_arn" &&
      aws_ssm_parameter.published["browser_id"].name == "/comparative/unit/50-agentcore/browser_id" &&
      aws_ssm_parameter.published["browser_arn"].name == "/comparative/unit/50-agentcore/browser_arn"
    )
    error_message = "parameters live under /comparative/<env>/50-agentcore/"
  }
  assert {
    condition = (
      aws_ssm_parameter.published["runtime_arn"].value == "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/cmp_unit_agent-AbCdEfGhIj" &&
      aws_ssm_parameter.published["browser_id"].value == "cmp_unit_studio_browser-AbCdEfGhIj" &&
      aws_ssm_parameter.published["browser_arn"].value == "arn:aws:bedrock-agentcore:us-east-1:111122223333:browser-custom/cmp_unit_studio_browser-AbCdEfGhIj"
    )
    error_message = "the parameters hold the module's outputs"
  }
  # The names the earlier stacks publish under; their own tests assert the
  # same keys.
  assert {
    condition = (
      data.aws_ssm_parameter.secrets_kms_key_arn.name == "/comparative/unit/00-foundation/kms/secrets_arn" &&
      data.aws_ssm_parameter.workload_boundary_arn.name == "/comparative/unit/00-foundation/iam/workload_boundary_arn" &&
      data.aws_ssm_parameter.agentcore_subnet_ids.name == "/comparative/unit/10-network/agentcore_subnet_ids" &&
      data.aws_ssm_parameter.agent_runtime_security_group_id.name == "/comparative/unit/10-network/sg/agent_runtime_id" &&
      data.aws_ssm_parameter.studio_browser_security_group_id.name == "/comparative/unit/10-network/sg/studio_browser_id" &&
      data.aws_ssm_parameter.proxy_url.name == "/comparative/unit/10-network/proxy_url" &&
      data.aws_ssm_parameter.no_proxy.name == "/comparative/unit/10-network/no_proxy" &&
      data.aws_ssm_parameter.app_secret_arn.name == "/comparative/unit/20-data/secret/app_arn" &&
      data.aws_ssm_parameter.browser_proxy_secret_arn.name == "/comparative/unit/20-data/secret/browser_proxy_arn"
    )
    error_message = "every input is read from the parameter its owning stack publishes"
  }

  # Model access: the same ARNs 40-services computes for the services.
  assert {
    condition = toset(local.bedrock_model_arns) == toset([
      "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.vendor.model-a-v1:0",
      "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.vendor.model-b",
      "arn:aws:bedrock:us-east-1::foundation-model/vendor.model-a-v1:0",
      "arn:aws:bedrock:us-east-1::foundation-model/vendor.model-b",
      "arn:aws:bedrock:us-east-2::foundation-model/vendor.model-a-v1:0",
      "arn:aws:bedrock:us-east-2::foundation-model/vendor.model-b",
      "arn:aws:bedrock:us-west-2::foundation-model/vendor.model-a-v1:0",
      "arn:aws:bedrock:us-west-2::foundation-model/vendor.model-b",
    ])
    error_message = "model ARNs are ids x prefix x routed regions"
  }
  assert {
    condition     = alltrue([for arn in local.bedrock_model_arns : !strcontains(arn, "*")])
    error_message = "no model ARN contains a wildcard"
  }
}

# --- a routine deploy: only image_agent of release.auto.tfvars changes ------------------

run "release" {
  command = plan

  variables {
    image_agent = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-agent@sha256:00000000000000000000000000000000000000000000000000000000000000c2"
  }

  assert {
    condition     = aws_ssm_parameter.published["runtime_arn"].name == "/comparative/unit/50-agentcore/runtime_arn"
    error_message = "a release publishes under the same names"
  }
}

# --- firewall mode: a VPC runtime behind the published proxy, without web search --------

run "firewall" {
  command = plan

  override_data {
    target = data.aws_ssm_parameter.proxy_url
    values = { insecure_value = "http://proxy.corp.example:3128" }
  }

  variables {
    agentcore_network_mode        = "VPC"
    agentcore_web_search_provider = "none"
  }

  assert {
    condition     = toset(keys(aws_ssm_parameter.published)) == toset(["runtime_arn", "browser_id", "browser_arn"])
    error_message = "firewall mode publishes the same three parameters"
  }
}

run "models_without_an_inference_profile" {
  command = plan

  variables {
    bedrock_inference_profile_prefix = ""
    bedrock_inference_regions        = ["eu-central-1"]
  }

  assert {
    condition = toset(local.bedrock_model_arns) == toset([
      "arn:aws:bedrock:eu-central-1::foundation-model/vendor.model-a-v1:0",
      "arn:aws:bedrock:eu-central-1::foundation-model/vendor.model-b",
    ])
    error_message = "without a prefix only the foundation models are listed"
  }
}

run "model_id_with_a_wildcard_is_rejected" {
  command = plan

  variables {
    bedrock_model_ids = ["vendor.*"]
  }

  expect_failures = [var.bedrock_model_ids]
}
