# The network of one environment: a VPC built here (create mode) or supplied by
# a landing zone (adopt mode), and the security groups of every workload.
#
#   main.tf             VPC, subnets, routing, flow logs
#   endpoints.tf        S3 gateway endpoint, interface endpoints
#   security_groups.tf  the groups and every rule between them
#   standin_proxy.tf    the optional forward proxy that imitates the organisation's

locals {
  create = var.mode == "create"

  # Public subnets carry a public load balancer and, in NAT mode, the NAT
  # gateway. An internal load balancer behind a firewall needs neither.
  create_public_subnets = local.create && !(var.internal_alb && var.firewall_mode)

  # The stand-in proxy is the one thing in a firewalled VPC that reaches the
  # internet, so it gets its own public subnet (for a NAT gateway) and its own
  # private subnet (for the task). The app subnets still have no default route.
  create_internet_gateway = local.create_public_subnets || var.create_standin_proxy
  create_nat_gateway      = local.create && (var.egress == "nat" || var.create_standin_proxy)

  # The VPC is a /16 and subnets are /20: sixteen slots. 0-3 app, 4-7 data,
  # 8-11 public, 12-13 stand-in.
  subnet_newbits = 4

  # A VPC built here uses only zones AgentCore Browser supports, in name order,
  # so every app subnet can carry the Browser and the zone set is a closed list.
  zones = {
    for slot in range(local.create ? var.az_count : 0) : tostring(slot) => {
      slot = slot
      name = data.aws_availability_zones.available[0].names[slot]
      id   = data.aws_availability_zones.available[0].zone_ids[slot]
    }
  }

  vpc_id   = local.create ? aws_vpc.this[0].id : var.vpc_id
  vpc_cidr = local.create ? var.vpc_cidr : data.aws_vpc.adopted[0].cidr_block

  app_subnet_ids    = local.create ? [for key, zone in local.zones : aws_subnet.app[key].id] : var.app_subnet_ids
  data_subnet_ids   = local.create ? [for key, zone in local.zones : aws_subnet.data[key].id] : var.data_subnet_ids
  public_subnet_ids = local.create ? [for key, subnet in aws_subnet.public : subnet.id] : var.public_subnet_ids

  # App subnets in a zone AgentCore Browser supports.
  agentcore_subnet_ids = local.create ? [
    for key, zone in local.zones : aws_subnet.app[key].id if contains(var.agentcore_az_ids, zone.id)
    ] : [
    for id in var.app_subnet_ids : id if contains(var.agentcore_az_ids, data.aws_subnet.app[id].availability_zone_id)
  ]

  # The Amazon DNS resolver sits at the VPC's base address plus two.
  resolver_ip = cidrhost(local.vpc_cidr, 2)
}

# --- adopt mode: read what the landing zone supplies ---------------------------

data "aws_vpc" "adopted" {
  count = local.create ? 0 : 1

  id = var.vpc_id
}

data "aws_subnet" "app" {
  for_each = local.create ? toset([]) : toset(var.app_subnet_ids)

  id = each.value
}

# --- create mode ---------------------------------------------------------------

data "aws_availability_zones" "available" {
  count = local.create ? 1 : 0

  state = "available"

  filter {
    name   = "zone-id"
    values = var.agentcore_az_ids
  }

  lifecycle {
    postcondition {
      condition     = length(self.zone_ids) >= var.az_count
      error_message = "Fewer of the zones in agentcore_az_ids are available in this account than az_count asks for."
    }
  }
}

resource "aws_vpc" "this" {
  count = local.create ? 1 : 0

  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name_prefix }
}

# The default security group is never used; adopting it removes its rules.
resource "aws_default_security_group" "this" {
  count = local.create ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  tags = { Name = "${var.name_prefix}-default-unused" }
}

resource "aws_subnet" "app" {
  for_each = local.zones

  vpc_id            = aws_vpc.this[0].id
  availability_zone = each.value.name
  cidr_block        = cidrsubnet(var.vpc_cidr, local.subnet_newbits, each.value.slot)

  tags = { Name = "${var.name_prefix}-app-${each.value.id}" }
}

resource "aws_subnet" "data" {
  for_each = local.zones

  vpc_id            = aws_vpc.this[0].id
  availability_zone = each.value.name
  cidr_block        = cidrsubnet(var.vpc_cidr, local.subnet_newbits, each.value.slot + 4)

  tags = { Name = "${var.name_prefix}-data-${each.value.id}" }
}

# Public only by its route to the internet gateway: nothing launched here gets
# a public address automatically.
resource "aws_subnet" "public" {
  for_each = local.create_public_subnets ? local.zones : {}

  vpc_id            = aws_vpc.this[0].id
  availability_zone = each.value.name
  cidr_block        = cidrsubnet(var.vpc_cidr, local.subnet_newbits, each.value.slot + 8)

  tags = { Name = "${var.name_prefix}-public-${each.value.id}" }
}

resource "aws_subnet" "standin_public" {
  count = var.create_standin_proxy ? 1 : 0

  vpc_id            = aws_vpc.this[0].id
  availability_zone = local.zones["0"].name
  cidr_block        = cidrsubnet(var.vpc_cidr, local.subnet_newbits, 12)

  tags = { Name = "${var.name_prefix}-standin-public" }
}

resource "aws_subnet" "standin_proxy" {
  count = var.create_standin_proxy ? 1 : 0

  vpc_id            = aws_vpc.this[0].id
  availability_zone = local.zones["0"].name
  cidr_block        = cidrsubnet(var.vpc_cidr, local.subnet_newbits, 13)

  tags = { Name = "${var.name_prefix}-standin-proxy" }
}

resource "aws_internet_gateway" "this" {
  count = local.create_internet_gateway ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  tags = { Name = var.name_prefix }
}

resource "aws_eip" "nat" {
  count = local.create_nat_gateway ? 1 : 0

  domain = "vpc"

  tags = { Name = "${var.name_prefix}-nat" }
}

# One NAT gateway, in one zone: a sandbox trades zone resilience for cost.
resource "aws_nat_gateway" "this" {
  count = local.create_nat_gateway ? 1 : 0

  allocation_id = aws_eip.nat[0].id
  subnet_id     = var.create_standin_proxy ? aws_subnet.standin_public[0].id : aws_subnet.public["0"].id

  tags = { Name = var.name_prefix }

  depends_on = [aws_internet_gateway.this]
}

# --- routing -------------------------------------------------------------------

resource "aws_route_table" "public" {
  count = local.create_internet_gateway ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  tags = { Name = "${var.name_prefix}-public" }
}

resource "aws_route" "public_default" {
  count = local.create_internet_gateway ? 1 : 0

  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this[0].id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_route_table_association" "standin_public" {
  count = var.create_standin_proxy ? 1 : 0

  subnet_id      = aws_subnet.standin_public[0].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_route_table" "app" {
  count = local.create ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  tags = { Name = "${var.name_prefix}-app" }
}

# The only default route the app subnets ever get, and only in NAT mode. In
# firewall mode this table has the local route and the S3 gateway route.
resource "aws_route" "app_default" {
  count = local.create && var.egress == "nat" ? 1 : 0

  route_table_id         = aws_route_table.app[0].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[0].id
}

resource "aws_route_table_association" "app" {
  for_each = aws_subnet.app

  subnet_id      = each.value.id
  route_table_id = aws_route_table.app[0].id
}

# Data subnets route inside the VPC only.
resource "aws_route_table" "data" {
  count = local.create ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  tags = { Name = "${var.name_prefix}-data" }
}

resource "aws_route_table_association" "data" {
  for_each = aws_subnet.data

  subnet_id      = each.value.id
  route_table_id = aws_route_table.data[0].id
}

resource "aws_route_table" "standin_proxy" {
  count = var.create_standin_proxy ? 1 : 0

  vpc_id = aws_vpc.this[0].id

  tags = { Name = "${var.name_prefix}-standin-proxy" }
}

resource "aws_route" "standin_proxy_default" {
  count = var.create_standin_proxy ? 1 : 0

  route_table_id         = aws_route_table.standin_proxy[0].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[0].id
}

resource "aws_route_table_association" "standin_proxy" {
  count = var.create_standin_proxy ? 1 : 0

  subnet_id      = aws_subnet.standin_proxy[0].id
  route_table_id = aws_route_table.standin_proxy[0].id
}

# --- flow logs -----------------------------------------------------------------

resource "aws_cloudwatch_log_group" "flow_logs" {
  #checkov:skip=CKV_AWS_338:30-day retention is the specified value for flow logs
  count = local.create ? 1 : 0

  name              = "/comparative/${var.env}/vpc-flow-logs"
  retention_in_days = 30
  kms_key_id        = var.logs_kms_key_arn
}

resource "aws_iam_role" "flow_logs" {
  count = local.create ? 1 : 0

  name                 = "${var.name_prefix}-vpc-flow-logs"
  path                 = "/comparative/${var.env}/"
  permissions_boundary = var.permissions_boundary_arn

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "flow_logs" {
  count = local.create ? 1 : 0

  name = "write-flow-logs"
  role = aws_iam_role.flow_logs[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.flow_logs[0].arn}:*"
    }]
  })
}

resource "aws_flow_log" "this" {
  count = local.create ? 1 : 0

  vpc_id          = aws_vpc.this[0].id
  traffic_type    = "ALL"
  log_destination = aws_cloudwatch_log_group.flow_logs[0].arn
  iam_role_arn    = aws_iam_role.flow_logs[0].arn

  tags = { Name = var.name_prefix }
}
