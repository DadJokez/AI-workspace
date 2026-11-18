# Root module for ../no_secret_in_plan.sh: the data module with made-up inputs,
# planned for real so that the plan can be read as JSON. `terraform test`
# cannot show a plan file, which is why this exists beside data.tftest.hcl.
#
# Nothing is contacted: the configuration reads no data source that calls AWS,
# the state is empty, and the credentials below are not credentials.

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

module "data" {
  source = "../.."

  env         = "unit"
  name_prefix = "cmp-unit"
  aws_region  = "us-east-1"
  account_id  = "111122223333"

  data_subnet_ids      = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
  db_security_group_id = "sg-0aaaaaaaaaaaaaaaa"

  data_kms_key_arn         = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001"
  secrets_kms_key_arn      = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000002"
  permissions_boundary_arn = "arn:aws:iam::111122223333:policy/cmp-unit-workload-boundary"

  engine_version             = "16.13"
  instance_class             = "db.t4g.micro"
  multi_az                   = false
  max_allocated_storage      = 100
  backup_days                = 7
  log_min_duration_statement = 1000
  db_name                    = "comparative"
  master_username            = "comparative_admin"
  enable_rds_proxy           = true
}
