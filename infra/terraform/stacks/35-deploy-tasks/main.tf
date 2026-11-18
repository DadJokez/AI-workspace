# 35-deploy-tasks: the two tasks the pipeline runs once per release, before and
# after the services move to it. The migrator applies the database migrations;
# the smoke task signs in and checks the deployed application. Neither has a
# service: each is a task definition with its roles and log group.
#
# The pipeline starts them with `ecs run-task` in the app subnets with the
# deploy_task security group, both published by 10-network.

# ARNs and a URL, not secrets: insecure_value keeps them readable in the plan.
data "aws_ssm_parameter" "logs_kms_key_arn" {
  name = "/comparative/${var.env}/00-foundation/kms/logs_arn"
}

data "aws_ssm_parameter" "secrets_kms_key_arn" {
  name = "/comparative/${var.env}/00-foundation/kms/secrets_arn"
}

data "aws_ssm_parameter" "workload_boundary_arn" {
  name = "/comparative/${var.env}/00-foundation/iam/workload_boundary_arn"
}

data "aws_ssm_parameter" "app_secret_arn" {
  name = "/comparative/${var.env}/20-data/secret/app_arn"
}

data "aws_ssm_parameter" "base_url" {
  name = "/comparative/${var.env}/30-platform/base_url"
}

locals {
  app_secret_arn = data.aws_ssm_parameter.app_secret_arn.insecure_value

  parameters = {
    "taskdef/migrator_arn" = module.migrator.task_definition_arn
    "taskdef/smoke_arn"    = module.smoke.task_definition_arn
  }
}

# The image's own command runs the migrations. It gets the database URL and
# nothing else: no task permissions, no other secret.
module "migrator" {
  source = "../../modules/ecs-task"

  env         = var.env
  name_prefix = var.name_prefix
  aws_region  = var.aws_region
  name        = "migrator"

  image  = var.image_migrator
  cpu    = 256
  memory = 512

  secrets = {
    DATABASE_URL = "${local.app_secret_arn}:DATABASE_URL::"
  }
  execution_secret_arns = [local.app_secret_arn]

  log_group_name           = "/comparative/${var.env}/migrator"
  kms_logs_arn             = data.aws_ssm_parameter.logs_kms_key_arn.insecure_value
  kms_secrets_arn          = data.aws_ssm_parameter.secrets_kms_key_arn.insecure_value
  permissions_boundary_arn = data.aws_ssm_parameter.workload_boundary_arn.insecure_value
}

module "smoke" {
  source = "../../modules/ecs-task"

  env         = var.env
  name_prefix = var.name_prefix
  aws_region  = var.aws_region
  name        = "smoke"

  image   = var.image_worker
  command = ["pnpm", "--filter", "@ai-workspace/web", "smoke:prod:auth"]
  cpu     = 256
  memory  = 512

  environment = {
    SMOKE_BASE_URL = var.internal_base_url != "" ? var.internal_base_url : data.aws_ssm_parameter.base_url.insecure_value
    SMOKE_RUN_ID   = var.release_id
  }
  secrets = {
    DATABASE_URL    = "${local.app_secret_arn}:DATABASE_URL::"
    NEXTAUTH_SECRET = "${local.app_secret_arn}:NEXTAUTH_SECRET::"
  }
  execution_secret_arns = [local.app_secret_arn]

  log_group_name           = "/comparative/${var.env}/smoke"
  kms_logs_arn             = data.aws_ssm_parameter.logs_kms_key_arn.insecure_value
  kms_secrets_arn          = data.aws_ssm_parameter.secrets_kms_key_arn.insecure_value
  permissions_boundary_arn = data.aws_ssm_parameter.workload_boundary_arn.insecure_value
}

# --- Published outputs -------------------------------------------------------

# The pipeline reads these to run the tasks. Each ARN carries its revision, so
# it changes with every release. ARNs, not secrets.
resource "aws_ssm_parameter" "published" {
  #checkov:skip=CKV2_AWS_34:Task definition ARNs, not secrets; plain String so the pipeline can read them
  for_each = local.parameters

  name  = "/comparative/${var.env}/35-deploy-tasks/${each.key}"
  type  = "String"
  value = each.value
}
