# 30-platform: what the services of one environment share. The ECS cluster, the
# private DNS namespace, and the load balancer with its listeners and the web
# target group; optionally the certificate, the DNS record and a WAF
# association.

# Ids and names, not secrets: insecure_value keeps them readable in the plan.
data "aws_ssm_parameter" "vpc_id" {
  name = "/comparative/${var.env}/10-network/vpc_id"
}

data "aws_ssm_parameter" "app_subnet_ids" {
  name = "/comparative/${var.env}/10-network/app_subnet_ids"
}

data "aws_ssm_parameter" "public_subnet_ids" {
  name = "/comparative/${var.env}/10-network/public_subnet_ids"
}

data "aws_ssm_parameter" "alb_security_group_id" {
  name = "/comparative/${var.env}/10-network/sg/alb_id"
}

data "aws_ssm_parameter" "alb_logs_bucket" {
  name = "/comparative/${var.env}/20-data/bucket/alb_logs"
}

locals {
  # 10-network publishes subnet lists as JSON arrays. An internal load
  # balancer sits in the app subnets, a public one in the public subnets.
  alb_subnet_ids = jsondecode(
    var.internal_alb ? data.aws_ssm_parameter.app_subnet_ids.insecure_value : data.aws_ssm_parameter.public_subnet_ids.insecure_value
  )

  request_certificate = var.certificate_arn == null
  certificate_arn     = local.request_certificate ? aws_acm_certificate_validation.this[0].certificate_arn : var.certificate_arn

  parameters = {
    "cluster_arn"       = aws_ecs_cluster.this.arn
    "cluster_name"      = aws_ecs_cluster.this.name
    "namespace_id"      = aws_service_discovery_private_dns_namespace.internal.id
    "alb_arn"           = aws_lb.this.arn
    "alb_dns_name"      = aws_lb.this.dns_name
    "alb_arn_suffix"    = aws_lb.this.arn_suffix
    "tg/web_arn"        = aws_lb_target_group.web.arn
    "tg/web_arn_suffix" = aws_lb_target_group.web.arn_suffix
    "base_url"          = "https://${var.domain_name}"
  }
}

# --- cluster and namespace ------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  #checkov:skip=CKV_AWS_65:Container Insights is charged per metric; var.container_insights turns it on where it is wanted
  name = "${var.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = var.container_insights ? "enabled" : "disabled"
  }
}

resource "aws_service_discovery_private_dns_namespace" "internal" {
  name        = var.internal_namespace
  description = "Comparative ${var.env}: private names of the services"
  vpc         = data.aws_ssm_parameter.vpc_id.insecure_value
}

# --- load balancer ----------------------------------------------------------------

resource "aws_lb" "this" {
  #checkov:skip=CKV_AWS_150:Deletion protection is var.alb_deletion_protection, off only in an environment that is rebuilt often
  #checkov:skip=CKV2_AWS_28:A web ACL is associated when var.waf_acl_arn is set; the ACL itself belongs to its owner
  name               = "${var.name_prefix}-alb"
  load_balancer_type = "application"
  internal           = var.internal_alb
  subnets            = local.alb_subnet_ids
  security_groups    = [data.aws_ssm_parameter.alb_security_group_id.insecure_value]

  drop_invalid_header_fields = true
  enable_deletion_protection = var.alb_deletion_protection

  # The bucket's policy lets load balancers write under AWSLogs/<account>/
  # only, so there is no prefix.
  access_logs {
    bucket  = data.aws_ssm_parameter.alb_logs_bucket.insecure_value
    enabled = true
  }
}

resource "aws_lb_target_group" "web" {
  #checkov:skip=CKV_AWS_378:TLS ends at the load balancer; the web tasks listen on plain HTTP inside the VPC, reachable from the load balancer's security group only
  name        = "${var.name_prefix}-web"
  vpc_id      = data.aws_ssm_parameter.vpc_id.insecure_value
  target_type = "ip"
  protocol    = "HTTP"
  port        = 3000

  deregistration_delay = 30

  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# A public load balancer answers plain HTTP with a redirect; an internal one
# does not listen on 80 at all.
resource "aws_lb_listener" "http" {
  count = var.internal_alb ? 0 : 1

  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

# --- certificate and DNS (optional) --------------------------------------------

resource "aws_acm_certificate" "this" {
  count = local.request_certificate ? 1 : 0

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = {
    for option in flatten(aws_acm_certificate.this[*].domain_validation_options) : option.domain_name => option
  }

  zone_id         = var.route53_zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  count = local.request_certificate ? 1 : 0

  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

resource "aws_route53_record" "alias" {
  count = var.route53_zone_id == null ? 0 : 1

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

# --- WAF (optional) --------------------------------------------------------------

resource "aws_wafv2_web_acl_association" "this" {
  count = var.waf_acl_arn == null ? 0 : 1

  resource_arn = aws_lb.this.arn
  web_acl_arn  = var.waf_acl_arn
}

# --- Published outputs -------------------------------------------------------

# Downstream stacks read these with aws_ssm_parameter data sources; there is no
# terraform_remote_state. The values are ARNs, names and a URL, not secrets.
resource "aws_ssm_parameter" "published" {
  #checkov:skip=CKV2_AWS_34:ARNs, names and a URL, not secrets; plain String so any downstream stack can read them
  for_each = local.parameters

  name  = "/comparative/${var.env}/30-platform/${each.key}"
  type  = "String"
  value = each.value
}
