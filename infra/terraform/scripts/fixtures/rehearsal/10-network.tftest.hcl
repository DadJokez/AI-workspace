# rehearsal.sh --plan-only: 10-network of personal-rehearsal against a mocked
# AWS provider. What 00-foundation publishes is supplied here; the variables
# come from envs/personal-rehearsal/env.tfvars and plan-only.tfvars.

mock_provider "aws" {
  override_during = plan

  mock_data "aws_availability_zones" {
    defaults = {
      names    = ["us-east-1a", "us-east-1b", "us-east-1d"]
      zone_ids = ["use1-az1", "use1-az2", "use1-az4"]
    }
  }

  mock_data "aws_ec2_managed_prefix_list" {
    defaults = {
      id = "pl-0123456789abcdef0"
    }
  }

  mock_resource "aws_vpc" {
    defaults = {}
  }

  mock_resource "aws_subnet" {
    defaults = {}
  }

  mock_resource "aws_route_table" {
    defaults = {}
  }

  mock_resource "aws_internet_gateway" {
    defaults = {}
  }

  mock_resource "aws_nat_gateway" {
    defaults = {}
  }

  mock_resource "aws_security_group" {
    defaults = {}
  }
}

override_data {
  target = data.aws_ssm_parameter.logs_kms_key_arn
  values = { insecure_value = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000003" }
}

override_data {
  target = data.aws_ssm_parameter.workload_boundary_arn
  values = { insecure_value = "arn:aws:iam::111122223333:policy/cmp-personal-rehearsal-workload-boundary" }
}

run "rehearsal" {
  command = plan
}
