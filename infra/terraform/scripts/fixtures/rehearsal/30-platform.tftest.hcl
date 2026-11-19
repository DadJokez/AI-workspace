# rehearsal.sh --plan-only: 30-platform of personal-rehearsal against a mocked
# AWS provider. What 10-network and 20-data publish is supplied here; the
# variables come from envs/personal-rehearsal/env.tfvars and plan-only.tfvars.

mock_provider "aws" {
  override_during = plan

  # The internal load balancer. Its name is the internal_base_url of
  # plan-only.tfvars.
  mock_resource "aws_lb" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/cmp-personal-rehearsal-alb/0123456789abcdef"
      arn_suffix = "app/cmp-personal-rehearsal-alb/0123456789abcdef"
      dns_name   = "internal-cmp-personal-rehearsal-alb-0123456789.us-east-1.elb.amazonaws.com"
      zone_id    = "Z35SXDOTRQ7X7K"
    }
  }

  mock_resource "aws_lb_target_group" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/cmp-personal-rehearsal-web/0123456789abcdef"
      arn_suffix = "targetgroup/cmp-personal-rehearsal-web/0123456789abcdef"
    }
  }

  mock_resource "aws_ecs_cluster" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:111122223333:cluster/cmp-personal-rehearsal-cluster"
    }
  }

  mock_resource "aws_service_discovery_private_dns_namespace" {
    defaults = {
      id = "ns-0123456789abcdef"
    }
  }
}

# --- 10-network -------------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.vpc_id
  values = { insecure_value = "vpc-0aaaaaaaaaaaaaaaa" }
}

override_data {
  target = data.aws_ssm_parameter.app_subnet_ids
  values = { insecure_value = "[\"subnet-0aaaaaaaaaaaaaaaa\",\"subnet-0bbbbbbbbbbbbbbbb\"]" }
}

# Firewall mode with an internal load balancer has no public subnets.
override_data {
  target = data.aws_ssm_parameter.public_subnet_ids
  values = { insecure_value = "[]" }
}

override_data {
  target = data.aws_ssm_parameter.alb_security_group_id
  values = { insecure_value = "sg-000000000000alb01" }
}

# --- 20-data ----------------------------------------------------------------------

override_data {
  target = data.aws_ssm_parameter.alb_logs_bucket
  values = { insecure_value = "cmp-personal-rehearsal-alb-logs-111122223333-us-east-1" }
}

run "rehearsal" {
  command = plan
}
