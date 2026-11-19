# Root module for ../policy_on_plan.sh: the agentcore module with made-up
# inputs, planned for real so that the plan can be read as JSON. `terraform
# test` cannot show a plan file, which is why this exists beside
# agentcore.tftest.hcl.
#
# Nothing is contacted: the only data source is the partition, which the
# provider derives from the region; the state is empty, and the credentials
# below are not credentials.

terraform {
  required_version = "~> 1.17"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
  }
}

provider "aws" {
  region     = "us-east-1"
  access_key = "not-a-credential"
  secret_key = "not-a-credential"

  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true

  default_tags {
    tags = {
      "app"         = "comparative"
      "env"         = "unit"
      "owner"       = "platform"
      "cost-center" = "none"
      "data-class"  = "internal"
      "managed-by"  = "terraform"
      "repo"        = "example-owner/example-repo"
    }
  }
}

# Firewall mode with web search: every resource the module can create.
module "agentcore" {
  source = "../.."

  env         = "unit"
  name_prefix = "cmp-unit"
  aws_region  = "us-east-1"
  account_id  = "111122223333"

  image                     = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-agent@sha256:00000000000000000000000000000000000000000000000000000000000000c1"
  network_mode              = "VPC"
  runtime_security_group_id = "sg-00000000000runtime"

  bedrock_model_arns = [
    "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.vendor.model-a-v1:0",
    "arn:aws:bedrock:us-east-1::foundation-model/vendor.model-a-v1:0",
  ]
  bedrock_inference_profile_prefix = "us."

  web_search_provider   = "brave"
  web_search_secret_arn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/app-AbCdEf"

  proxy_url = "http://proxy.corp.example:3128"
  no_proxy  = "169.254.170.2,localhost,127.0.0.1"

  browser_network_mode      = "VPC"
  browser_security_group_id = "sg-00000000000browser"
  browser_proxy_secret_arn  = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/browser-proxy-GhIjKl"

  subnet_ids               = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
  kms_secrets_arn          = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000002"
  permissions_boundary_arn = "arn:aws:iam::111122223333:policy/cmp-unit-workload-boundary"
}
