# Tests of the stack against a mocked AWS provider: no credentials, no real
# state, no AWS calls. What the earlier stacks and 50-agentcore publish is
# supplied here.
#
# The first run applies against the mock, so that the runs after it plan
# against a state: "release" is then the plan of a routine deploy. A test file
# can only assert on what the root module sees (locals, module outputs, the
# published parameters). What the modules plan inside, and which resources a
# release touches, is checked by services.sh, which reads the plans these runs
# produce.

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

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:111122223333:log-group:/comparative/unit/mock"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111122223333:role/comparative/unit/mock"
    }
  }

  mock_resource "aws_ecs_task_definition" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:111122223333:task-definition/cmp-unit-mock:1"
    }
  }

  mock_resource "aws_service_discovery_service" {
    defaults = {
      arn = "arn:aws:servicediscovery:us-east-1:111122223333:service/srv-0123456789abcdef"
    }
  }
}

# --- 00-foundation ---------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.logs_kms_key_arn
  values = { insecure_value = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001" }
}

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
  target = data.aws_ssm_parameter.app_subnet_ids
  values = { insecure_value = "[\"subnet-0aaaaaaaaaaaaaaaa\",\"subnet-0bbbbbbbbbbbbbbbb\"]" }
}

override_data {
  target = data.aws_ssm_parameter.web_security_group_id
  values = { insecure_value = "sg-0000000000000web1" }
}

override_data {
  target = data.aws_ssm_parameter.worker_security_group_id
  values = { insecure_value = "sg-0000000000worker1" }
}

override_data {
  target = data.aws_ssm_parameter.browser_proxy_security_group_id
  values = { insecure_value = "sg-00000000000proxy1" }
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

override_data {
  target = data.aws_ssm_parameter.browser_proxy_db_secret_arn
  values = { insecure_value = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/browser-proxy-db-MnOpQr" }
}

# --- 30-platform ------------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.cluster_arn
  values = { insecure_value = "arn:aws:ecs:us-east-1:111122223333:cluster/cmp-unit-cluster" }
}

override_data {
  target = data.aws_ssm_parameter.namespace_id
  values = { insecure_value = "ns-0123456789abcdef" }
}

override_data {
  target = data.aws_ssm_parameter.web_target_group_arn
  values = { insecure_value = "arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/cmp-unit-web/0123456789abcdef" }
}

override_data {
  target = data.aws_ssm_parameter.base_url
  values = { insecure_value = "https://app.example.com" }
}

# --- 50-agentcore -----------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.runtime_arn
  values = { insecure_value = "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/cmp_unit_agent-AbCdEfGhIj" }
}

override_data {
  target = data.aws_ssm_parameter.browser_id
  values = { insecure_value = "cmp_unit_studio_browser-AbCdEfGhIj" }
}

override_data {
  target = data.aws_ssm_parameter.browser_arn
  values = { insecure_value = "arn:aws:bedrock-agentcore:us-east-1:111122223333:browser-custom/cmp_unit_studio_browser-AbCdEfGhIj" }
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

  image_web           = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-app@sha256:00000000000000000000000000000000000000000000000000000000000000a1"
  image_worker        = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-app@sha256:00000000000000000000000000000000000000000000000000000000000000a2"
  image_memory_worker = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-app@sha256:00000000000000000000000000000000000000000000000000000000000000a3"

  web_min           = 2
  web_max           = 4
  chat_worker_count = 1

  internal_namespace = "unit.comparative.internal"

  invite_email_provider = "ses"
  invite_email_from     = "no-reply@app.example.com"
  invite_email_identity = "app.example.com"

  # Made-up ids: the stack must not care what a model is called.
  bedrock_model_ids                = ["vendor.model-a-v1:0", "vendor.model-b"]
  bedrock_inference_profile_prefix = "us."
  bedrock_inference_regions        = ["us-east-1", "us-east-2", "us-west-2"]

  agentcore_browser_enabled = true
}

# --- a new environment --------------------------------------------------------------

run "baseline" {
  command = apply

  assert {
    condition = toset(keys(aws_ssm_parameter.published)) == toset([
      "service/web_name", "service/chat_worker_name", "service/memory_worker_name", "service/browser_proxy_name",
    ])
    error_message = "the stack publishes the four service names"
  }
  assert {
    condition = (
      aws_ssm_parameter.published["service/web_name"].name == "/comparative/unit/40-services/service/web_name" &&
      aws_ssm_parameter.published["service/web_name"].value == "cmp-unit-web" &&
      aws_ssm_parameter.published["service/chat_worker_name"].value == "cmp-unit-chat-worker" &&
      aws_ssm_parameter.published["service/memory_worker_name"].value == "cmp-unit-memory-worker" &&
      aws_ssm_parameter.published["service/browser_proxy_name"].value == "cmp-unit-browser-proxy"
    )
    error_message = "parameters live under /comparative/<env>/40-services/ and hold the service names"
  }

  # Model access: the inference profile of each model in the home region and
  # the foundation model in each routed region. Never a wildcard.
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

# --- a routine deploy: only release.auto.tfvars changes -----------------------------

run "release" {
  command = plan

  variables {
    image_web           = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-app@sha256:00000000000000000000000000000000000000000000000000000000000000b1"
    image_worker        = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-app@sha256:00000000000000000000000000000000000000000000000000000000000000b2"
    image_memory_worker = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-app@sha256:00000000000000000000000000000000000000000000000000000000000000b3"
  }

  assert {
    condition     = aws_ssm_parameter.published["service/web_name"].value == "cmp-unit-web"
    error_message = "a release does not rename a service"
  }
}

# --- variations ---------------------------------------------------------------------

run "proxy_and_internal_url" {
  command = plan

  override_data {
    target = data.aws_ssm_parameter.proxy_url
    values = { insecure_value = "http://proxy.corp.example:3128" }
  }

  variables {
    internal_base_url          = "https://internal.app.example.com"
    legacy_host_redirect_from  = "old.example.com"
    agentcore_browser_enabled  = false
    optional_app_secret_fields = ["OIDC_CLIENT_SECRET"]
    extra_environment = {
      WEB_SEARCH_PROVIDER = "none"
      RUNTIME             = "must-not-reach-the-chat-worker"
    }
  }

  assert {
    condition = (
      local.proxy_environment.HTTPS_PROXY == "http://proxy.corp.example:3128" &&
      local.proxy_environment.HTTP_PROXY == "http://proxy.corp.example:3128" &&
      local.proxy_environment.NO_PROXY == "169.254.170.2,localhost,127.0.0.1"
    )
    error_message = "a published proxy becomes HTTPS_PROXY, HTTP_PROXY and NO_PROXY"
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
