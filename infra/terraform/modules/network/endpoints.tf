# VPC endpoints. The S3 gateway endpoint is free and always present in a VPC
# built here. Interface endpoints exist only in firewall mode, where they are
# the app subnets' only path to AWS APIs.

locals {
  interface_endpoints = var.firewall_mode ? toset(var.interface_endpoints) : toset([])

  # Names that resolve to an interface endpoint inside the VPC. A wildcard name
  # ("*.dkr.ecr.<region>.amazonaws.com") becomes a NO_PROXY suffix (".dkr...").
  endpoint_dns_names = sort(distinct([
    for name in flatten([for service in data.aws_vpc_endpoint_service.interface : service.private_dns_names]) :
    trimprefix(name, "*")
  ]))

  # S3 is reached through the gateway endpoint's route, never through a proxy.
  s3_dns_names = ["s3.${var.aws_region}.amazonaws.com", ".s3.${var.aws_region}.amazonaws.com"]

  # Internal load balancers get a name under this suffix, so the internal base
  # URL bypasses the proxy without this stack knowing the load balancer.
  elb_dns_suffix = ".${var.aws_region}.elb.amazonaws.com"

  # 169.254.170.2 is the ECS task metadata and credentials endpoint.
  no_proxy = join(",", concat(
    local.endpoint_dns_names,
    local.s3_dns_names,
    [local.elb_dns_suffix, "169.254.170.2", "localhost", "127.0.0.1", local.resolver_ip],
  ))
}

# The prefix list of S3's addresses: what a security group names to allow the
# gateway endpoint. In adopt mode the landing zone owns the gateway endpoint.
data "aws_ec2_managed_prefix_list" "s3" {
  name = "com.amazonaws.${var.aws_region}.s3"
}

resource "aws_vpc_endpoint" "s3" {
  count = local.create ? 1 : 0

  vpc_id            = aws_vpc.this[0].id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.app[0].id]

  tags = { Name = "${var.name_prefix}-s3" }
}

# Looking the service up makes a plan fail on a name the region does not offer,
# and yields the DNS names the endpoint takes over.
data "aws_vpc_endpoint_service" "interface" {
  for_each = local.interface_endpoints

  service_name = "com.amazonaws.${var.aws_region}.${each.value}"
  service_type = "Interface"
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_endpoints

  vpc_id              = local.vpc_id
  service_name        = data.aws_vpc_endpoint_service.interface[each.value].service_name
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.app_subnet_ids
  security_group_ids  = [aws_security_group.this["endpoints"].id]
  private_dns_enabled = true

  tags = { Name = "${var.name_prefix}-${replace(each.value, ".", "-")}" }
}
