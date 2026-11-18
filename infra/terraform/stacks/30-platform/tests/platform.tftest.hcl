# Plan-only tests of the stack with a mocked AWS provider: no credentials, no
# state, no AWS calls. What 10-network and 20-data publish is supplied here.

mock_provider "aws" {
  override_during = plan

  # Declaring a resource type here is what makes its computed attributes
  # available while planning.
  mock_resource "aws_lb" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/cmp-unit-alb/0123456789abcdef"
      arn_suffix = "app/cmp-unit-alb/0123456789abcdef"
      dns_name   = "cmp-unit-alb-1234567890.us-east-1.elb.amazonaws.com"
      zone_id    = "Z35SXDOTRQ7X7K"
    }
  }

  mock_resource "aws_lb_target_group" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/cmp-unit-web/0123456789abcdef"
      arn_suffix = "targetgroup/cmp-unit-web/0123456789abcdef"
    }
  }

  mock_resource "aws_ecs_cluster" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:111122223333:cluster/cmp-unit-cluster"
    }
  }

  mock_resource "aws_service_discovery_private_dns_namespace" {
    defaults = {
      id = "ns-0123456789abcdef"
    }
  }

  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:111122223333:certificate/00000000-0000-0000-0000-00000000000a"
      domain_validation_options = [{
        domain_name           = "app.example.com"
        resource_record_name  = "_token.app.example.com."
        resource_record_type  = "CNAME"
        resource_record_value = "_value.acm-validations.aws."
      }]
    }
  }

  mock_resource "aws_acm_certificate_validation" {
    defaults = {
      certificate_arn = "arn:aws:acm:us-east-1:111122223333:certificate/00000000-0000-0000-0000-00000000000a"
    }
  }
}

override_data {
  target = data.aws_ssm_parameter.vpc_id
  values = { insecure_value = "vpc-0aaaaaaaaaaaaaaaa" }
}

override_data {
  target = data.aws_ssm_parameter.app_subnet_ids
  values = { insecure_value = "[\"subnet-0aaaaaaaaaaaaaaaa\",\"subnet-0bbbbbbbbbbbbbbbb\"]" }
}

override_data {
  target = data.aws_ssm_parameter.public_subnet_ids
  values = { insecure_value = "[\"subnet-0cccccccccccccccc\",\"subnet-0dddddddddddddddd\"]" }
}

override_data {
  target = data.aws_ssm_parameter.alb_security_group_id
  values = { insecure_value = "sg-0aaaaaaaaaaaaaaaa" }
}

override_data {
  target = data.aws_ssm_parameter.alb_logs_bucket
  values = { insecure_value = "cmp-unit-alb-logs-111122223333-us-east-1" }
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

  internal_namespace      = "unit.comparative.internal"
  internal_alb            = false
  alb_deletion_protection = true
  domain_name             = "app.example.com"
  certificate_arn         = "arn:aws:acm:us-east-1:111122223333:certificate/00000000-0000-0000-0000-000000000001"
}

# --- cluster and namespace ------------------------------------------------------

run "cluster_and_namespace" {
  command = plan

  assert {
    condition     = aws_ecs_cluster.this.name == "cmp-unit-cluster"
    error_message = "the cluster is <name_prefix>-cluster"
  }
  assert {
    condition     = one(aws_ecs_cluster.this.setting).name == "containerInsights" && one(aws_ecs_cluster.this.setting).value == "disabled"
    error_message = "Container Insights is off unless asked for"
  }
  assert {
    condition = (
      aws_service_discovery_private_dns_namespace.internal.name == "unit.comparative.internal" &&
      aws_service_discovery_private_dns_namespace.internal.vpc == "vpc-0aaaaaaaaaaaaaaaa"
    )
    error_message = "the private namespace is var.internal_namespace in the environment's VPC"
  }
}

run "container_insights_on" {
  command = plan

  variables {
    container_insights = true
  }

  assert {
    condition     = one(aws_ecs_cluster.this.setting).value == "enabled"
    error_message = "var.container_insights turns Container Insights on"
  }
}

# --- a public load balancer ------------------------------------------------------

run "public_load_balancer" {
  command = plan

  assert {
    condition = (
      aws_lb.this.internal == false &&
      aws_lb.this.load_balancer_type == "application" &&
      aws_lb.this.subnets == toset(["subnet-0cccccccccccccccc", "subnet-0dddddddddddddddd"]) &&
      aws_lb.this.security_groups == toset(["sg-0aaaaaaaaaaaaaaaa"])
    )
    error_message = "a public load balancer sits in the public subnets with the alb security group"
  }
  assert {
    condition     = aws_lb.this.drop_invalid_header_fields == true
    error_message = "invalid header fields are dropped"
  }
  assert {
    condition     = aws_lb.this.enable_deletion_protection == true
    error_message = "deletion protection follows var.alb_deletion_protection"
  }
  assert {
    condition = (
      aws_lb.this.access_logs[0].enabled == true &&
      aws_lb.this.access_logs[0].bucket == "cmp-unit-alb-logs-111122223333-us-east-1" &&
      aws_lb.this.access_logs[0].prefix == null
    )
    error_message = "access logs go to the alb-logs bucket, without a prefix"
  }
  assert {
    condition = (
      aws_lb_listener.https.port == 443 &&
      aws_lb_listener.https.protocol == "HTTPS" &&
      aws_lb_listener.https.ssl_policy == "ELBSecurityPolicy-TLS13-1-2-2021-06" &&
      aws_lb_listener.https.certificate_arn == var.certificate_arn
    )
    error_message = "the HTTPS listener uses the given certificate and the TLS 1.3 / 1.2 policy"
  }
  assert {
    condition = (
      aws_lb_listener.https.default_action[0].type == "forward" &&
      aws_lb_listener.https.default_action[0].target_group_arn == aws_lb_target_group.web.arn
    )
    error_message = "HTTPS requests go to the web target group"
  }
  assert {
    condition = (
      length(aws_lb_listener.http) == 1 &&
      aws_lb_listener.http[0].port == 80 &&
      aws_lb_listener.http[0].default_action[0].type == "redirect" &&
      aws_lb_listener.http[0].default_action[0].redirect[0].protocol == "HTTPS" &&
      aws_lb_listener.http[0].default_action[0].redirect[0].port == "443" &&
      aws_lb_listener.http[0].default_action[0].redirect[0].status_code == "HTTP_301"
    )
    error_message = "a public load balancer answers HTTP with a 301 to HTTPS"
  }
  assert {
    condition = (
      length(aws_acm_certificate.this) == 0 &&
      length(aws_route53_record.alias) == 0 &&
      length(aws_route53_record.certificate_validation) == 0 &&
      length(aws_wafv2_web_acl_association.this) == 0
    )
    error_message = "no certificate, DNS record or WAF association unless asked for"
  }
}

run "web_target_group" {
  command = plan

  assert {
    condition = (
      aws_lb_target_group.web.name == "cmp-unit-web" &&
      aws_lb_target_group.web.protocol == "HTTP" &&
      aws_lb_target_group.web.port == 3000 &&
      aws_lb_target_group.web.target_type == "ip" &&
      aws_lb_target_group.web.vpc_id == "vpc-0aaaaaaaaaaaaaaaa"
    )
    error_message = "the web target group takes task IPs on HTTP 3000"
  }
  assert {
    condition = (
      aws_lb_target_group.web.health_check[0].path == "/api/health" &&
      aws_lb_target_group.web.health_check[0].matcher == "200" &&
      aws_lb_target_group.web.health_check[0].interval == 30 &&
      aws_lb_target_group.web.health_check[0].timeout == 10 &&
      aws_lb_target_group.web.health_check[0].healthy_threshold == 2 &&
      aws_lb_target_group.web.health_check[0].unhealthy_threshold == 3
    )
    error_message = "health check: /api/health answers 200, every 30 s, 10 s timeout, 2 up / 3 down"
  }
  assert {
    condition     = aws_lb_target_group.web.deregistration_delay == "30"
    error_message = "a task is drained for 30 seconds"
  }
}

# --- an internal load balancer ---------------------------------------------------

run "internal_load_balancer" {
  command = plan

  variables {
    internal_alb = true
  }

  assert {
    condition = (
      aws_lb.this.internal == true &&
      aws_lb.this.subnets == toset(["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"])
    )
    error_message = "an internal load balancer sits in the app subnets"
  }
  assert {
    condition     = length(aws_lb_listener.http) == 0
    error_message = "an internal load balancer has no HTTP listener"
  }
  assert {
    condition     = aws_lb_listener.https.ssl_policy == "ELBSecurityPolicy-TLS13-1-2-2021-06"
    error_message = "the HTTPS listener is the same"
  }
}

# --- certificate, DNS and WAF ----------------------------------------------------

run "certificate_or_zone_is_required" {
  command = plan

  variables {
    certificate_arn = null
  }

  expect_failures = [var.certificate_arn]
}

run "certificate_and_record_from_the_zone" {
  command = plan

  variables {
    certificate_arn = null
    route53_zone_id = "Z0123456789ABCDEFGHIJ"
  }

  assert {
    condition = (
      aws_acm_certificate.this[0].domain_name == "app.example.com" &&
      aws_acm_certificate.this[0].validation_method == "DNS"
    )
    error_message = "without a certificate one is requested for domain_name, validated by DNS"
  }
  assert {
    condition = (
      length(aws_route53_record.certificate_validation) == 1 &&
      aws_route53_record.certificate_validation["app.example.com"].zone_id == "Z0123456789ABCDEFGHIJ"
    )
    error_message = "the validation record is created in the zone"
  }
  assert {
    condition     = aws_lb_listener.https.certificate_arn == aws_acm_certificate_validation.this[0].certificate_arn
    error_message = "the listener waits for the validated certificate"
  }
  assert {
    condition = (
      aws_route53_record.alias[0].zone_id == "Z0123456789ABCDEFGHIJ" &&
      aws_route53_record.alias[0].name == "app.example.com" &&
      aws_route53_record.alias[0].type == "A" &&
      one(aws_route53_record.alias[0].alias).name == aws_lb.this.dns_name
    )
    error_message = "domain_name is an alias of the load balancer"
  }
}

run "waf_association" {
  command = plan

  variables {
    waf_acl_arn = "arn:aws:wafv2:us-east-1:111122223333:regional/webacl/unit/00000000-0000-0000-0000-000000000001"
  }

  assert {
    condition = (
      aws_wafv2_web_acl_association.this[0].web_acl_arn == var.waf_acl_arn &&
      aws_wafv2_web_acl_association.this[0].resource_arn == aws_lb.this.arn
    )
    error_message = "the web ACL is associated with the load balancer"
  }
}

# --- published outputs ------------------------------------------------------------

run "published_parameters" {
  command = plan

  assert {
    condition = toset(keys(aws_ssm_parameter.published)) == toset([
      "cluster_arn", "cluster_name", "namespace_id", "alb_arn", "alb_dns_name", "alb_arn_suffix",
      "tg/web_arn", "tg/web_arn_suffix", "base_url",
    ])
    error_message = "the stack publishes exactly the keys downstream stacks read"
  }
  assert {
    condition = alltrue([
      for key, parameter in aws_ssm_parameter.published : parameter.name == "/comparative/unit/30-platform/${key}"
    ])
    error_message = "parameters live under /comparative/<env>/30-platform/"
  }
  assert {
    condition     = aws_ssm_parameter.published["base_url"].value == "https://app.example.com"
    error_message = "base_url is https://<domain_name>"
  }
  assert {
    condition     = aws_ssm_parameter.published["cluster_name"].value == "cmp-unit-cluster"
    error_message = "cluster_name is the cluster's name"
  }
}
