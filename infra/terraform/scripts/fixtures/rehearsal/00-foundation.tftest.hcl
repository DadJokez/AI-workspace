# rehearsal.sh --plan-only: 00-foundation of personal-rehearsal against a
# mocked AWS provider. The variables come from envs/personal-rehearsal/env.tfvars
# and plan-only.tfvars.

mock_provider "aws" {
  override_during = plan

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

  # personal-stage owns the account's GitHub OIDC provider; this one looks it up.
  mock_data "aws_iam_openid_connect_provider" {
    defaults = {
      arn = "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
    }
  }

  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001"
    }
  }

  mock_resource "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:us-east-1:111122223333:repository/cmp-personal-rehearsal-app"
      repository_url = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-rehearsal-app"
    }
  }

  mock_resource "aws_iam_policy" {
    defaults = {
      arn = "arn:aws:iam::111122223333:policy/cmp-personal-rehearsal-workload-boundary"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111122223333:role/cmp-personal-rehearsal-mock"
    }
  }
}

run "rehearsal" {
  command = plan
}
