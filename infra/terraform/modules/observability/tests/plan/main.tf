# Root module for ../policy_on_plan.sh: the observability module with made-up
# inputs, planned for real so that the plan can be read as JSON. `terraform
# test` cannot show a plan file, which is why this exists beside
# observability.tftest.hcl.
#
# Nothing is contacted: the configuration reads no data source, the state is
# empty, and the credentials below are not credentials.

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

module "observability" {
  source = "../.."

  env         = "unit"
  name_prefix = "cmp-unit"
  aws_region  = "us-east-1"

  kms_key_arn  = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001"
  alert_emails = ["ops@example.com"]

  cluster_name = "cmp-unit-cluster"
  service_names = {
    web           = "cmp-unit-web"
    chat_worker   = "cmp-unit-chat-worker"
    memory_worker = "cmp-unit-memory-worker"
    browser_proxy = "cmp-unit-browser-proxy"
  }
  alb_arn_suffix               = "app/cmp-unit-alb/0123456789abcdef"
  web_target_group_arn_suffix  = "targetgroup/cmp-unit-web/fedcba9876543210"
  chat_worker_log_group_name   = "/comparative/unit/chat-worker"
  memory_worker_log_group_name = "/comparative/unit/memory-worker"

  web_min = 2
  quota_alarm_models = [
    { model_id = "vendor.model-a-v1:0", daily_quota = 1000000, output_burndown = 5 },
  ]
}
