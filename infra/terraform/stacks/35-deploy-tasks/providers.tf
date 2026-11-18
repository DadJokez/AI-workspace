provider "aws" {
  region = var.aws_region

  # Refuse to plan or apply against any other account.
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = var.tags
  }
}
