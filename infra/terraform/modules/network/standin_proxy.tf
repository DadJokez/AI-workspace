# The stand-in proxy: one small Fargate task running squid with an explicit host
# allowlist, in the only subnet of a firewalled VPC that has a NAT route. It
# exists to imitate the organisation's proxy in a rehearsal environment and has
# no other purpose. Reachable only from the proxied security groups.
#
# The repository's own egress proxy (apps/web/lib/browser-egress-proxy.ts) is
# not used here: it takes its policy from the database, not from an allowlist
# in the environment, and it requires proxy credentials.

locals {
  # Ubuntu's squid image, pinned by the digest of its multi-architecture index.
  standin_proxy_image = "public.ecr.aws/ubuntu/squid:6.6-24.04_edge@sha256:8a3baed477e2c282ab8aa5edad442f69873246964f225c5c2ae8364b6610963c"

  standin_proxy_host = "proxy.${var.name_prefix}-egress.internal"

  # Anything not on the allowlist is refused. squid writes one access.log line
  # per request, allowed or denied, and the image's entrypoint copies that file
  # to the task's output.
  standin_proxy_config = join("\n", [
    "http_port 3128",
    "acl allowed_hosts dstdomain ${join(" ", var.proxy_allowlist)}",
    "acl tls_ports port 443",
    "acl web_ports port 80 443",
    "acl CONNECT method CONNECT",
    "http_access deny !web_ports",
    "http_access deny CONNECT !tls_ports",
    "http_access allow allowed_hosts",
    "http_access deny all",
    "cache deny all",
    "",
  ])

  proxy_url = var.create_standin_proxy ? "http://${local.standin_proxy_host}:3128" : var.proxy_url
}

resource "aws_cloudwatch_log_group" "standin_proxy" {
  count = var.create_standin_proxy ? 1 : 0

  name              = "/comparative/${var.env}/standin-proxy"
  retention_in_days = 30
  kms_key_id        = var.logs_kms_key_arn
}

resource "aws_iam_role" "standin_proxy_execution" {
  count = var.create_standin_proxy ? 1 : 0

  name                 = "${var.name_prefix}-standin-proxy-execution"
  path                 = "/comparative/${var.env}/"
  permissions_boundary = var.permissions_boundary_arn

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# The image is public, so the execution role only writes logs.
resource "aws_iam_role_policy" "standin_proxy_execution" {
  count = var.create_standin_proxy ? 1 : 0

  name = "write-logs"
  role = aws_iam_role.standin_proxy_execution[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.standin_proxy[0].arn}:*"
    }]
  })
}

resource "aws_ecs_cluster" "standin_proxy" {
  count = var.create_standin_proxy ? 1 : 0

  name = "${var.name_prefix}-standin-proxy"
}

resource "aws_ecs_task_definition" "standin_proxy" {
  count = var.create_standin_proxy ? 1 : 0

  family                   = "${var.name_prefix}-standin-proxy"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.standin_proxy_execution[0].arn

  container_definitions = jsonencode([{
    name      = "squid"
    image     = local.standin_proxy_image
    essential = true

    # Write the configuration, then hand over to the image's entrypoint, which
    # forwards squid's log files to the task's output.
    entryPoint = ["/bin/bash", "-c"]
    command    = ["printf '%s' \"$SQUID_CONFIG\" > /etc/squid/squid.conf && exec entrypoint.sh -f /etc/squid/squid.conf -NYC"]

    environment  = [{ name = "SQUID_CONFIG", value = local.standin_proxy_config }]
    portMappings = [{ containerPort = 3128, protocol = "tcp" }]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.standin_proxy[0].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "squid"
      }
    }
  }])
}

# A private DNS name for the task, so proxy_url survives a task replacement.
resource "aws_service_discovery_private_dns_namespace" "standin_proxy" {
  count = var.create_standin_proxy ? 1 : 0

  name = "${var.name_prefix}-egress.internal"
  vpc  = aws_vpc.this[0].id
}

resource "aws_service_discovery_service" "standin_proxy" {
  count = var.create_standin_proxy ? 1 : 0

  name = "proxy"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.standin_proxy[0].id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

resource "aws_ecs_service" "standin_proxy" {
  count = var.create_standin_proxy ? 1 : 0

  name            = "${var.name_prefix}-standin-proxy"
  cluster         = aws_ecs_cluster.standin_proxy[0].arn
  task_definition = aws_ecs_task_definition.standin_proxy[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [aws_subnet.standin_proxy[0].id]
    security_groups  = [aws_security_group.this["standin_proxy"].id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.standin_proxy[0].arn
  }

  # The task needs its way out before it can pull its image.
  depends_on = [aws_route.standin_proxy_default]
}
