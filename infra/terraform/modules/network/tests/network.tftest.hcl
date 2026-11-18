# Plan-only tests with a mocked provider: no credentials, no AWS calls.
# override_during = plan gives the ids of the mocked resource types below a
# value while planning, so rules can be checked against what they reference.

mock_provider "aws" {
  override_during = plan

  # What the zone-id filter leaves in an account where us-east-1a is a zone
  # AgentCore Browser does not support.
  mock_data "aws_availability_zones" {
    defaults = {
      names    = ["us-east-1b", "us-east-1c", "us-east-1d"]
      zone_ids = ["use1-az1", "use1-az2", "use1-az4"]
    }
  }

  # Declaring a resource type here is what makes its computed attributes
  # available while planning.
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

  mock_data "aws_vpc" {
    defaults = {
      cidr_block = "10.20.0.0/16"
    }
  }

  mock_data "aws_subnet" {
    defaults = {
      availability_zone_id = "use1-az1"
    }
  }

  mock_data "aws_ec2_managed_prefix_list" {
    defaults = {
      id = "pl-0123456789abcdef0"
    }
  }

  mock_data "aws_vpc_endpoint_service" {
    defaults = {
      private_dns_names = ["service.us-east-1.amazonaws.com", "*.wildcard.us-east-1.amazonaws.com"]
    }
  }
}

variables {
  env         = "unit"
  name_prefix = "cmp-unit"
  aws_region  = "us-east-1"

  agentcore_az_ids = ["use1-az1", "use1-az2", "use1-az4"]

  logs_kms_key_arn         = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000"
  permissions_boundary_arn = "arn:aws:iam::111122223333:policy/cmp-unit-workload-boundary"
}

# --- create + nat: the sandbox ---------------------------------------------------

run "create_nat" {
  command = plan

  variables {
    mode              = "create"
    vpc_cidr          = "10.10.0.0/16"
    firewall_mode     = false
    internal_alb      = false
    alb_ingress_cidrs = ["0.0.0.0/0"]
    egress            = "nat"
  }

  assert {
    condition     = aws_vpc.this[0].enable_dns_support && aws_vpc.this[0].enable_dns_hostnames
    error_message = "the VPC must have DNS support"
  }
  assert {
    condition = (
      [for key, subnet in aws_subnet.app : subnet.cidr_block] == ["10.10.0.0/20", "10.10.16.0/20"] &&
      [for key, subnet in aws_subnet.data : subnet.cidr_block] == ["10.10.64.0/20", "10.10.80.0/20"] &&
      [for key, subnet in aws_subnet.public : subnet.cidr_block] == ["10.10.128.0/20", "10.10.144.0/20"]
    )
    error_message = "two zones, each with one /20 app, data and public subnet"
  }
  assert {
    condition     = length(aws_nat_gateway.this) == 1 && length(aws_internet_gateway.this) == 1
    error_message = "NAT mode has one NAT gateway and an internet gateway"
  }
  assert {
    condition     = aws_nat_gateway.this[0].subnet_id == aws_subnet.public["0"].id
    error_message = "the NAT gateway sits in a public subnet"
  }
  assert {
    condition = (
      length(aws_route.app_default) == 1 &&
      aws_route.app_default[0].nat_gateway_id == aws_nat_gateway.this[0].id &&
      aws_route.app_default[0].gateway_id == null
    )
    error_message = "the app subnets' default route goes to the NAT gateway, never to the internet gateway"
  }
  assert {
    condition     = length(aws_vpc_endpoint.s3) == 1 && length(aws_vpc_endpoint.interface) == 0
    error_message = "NAT mode has the S3 gateway endpoint and no interface endpoints"
  }
  assert {
    condition     = aws_cloudwatch_log_group.flow_logs[0].retention_in_days == 30 && aws_cloudwatch_log_group.flow_logs[0].kms_key_id == var.logs_kms_key_arn
    error_message = "flow logs go to a KMS-encrypted log group kept for 30 days"
  }
  assert {
    condition     = aws_flow_log.this[0].traffic_type == "ALL"
    error_message = "flow logs record all traffic"
  }
  assert {
    condition     = aws_iam_role.flow_logs[0].path == "/comparative/unit/" && aws_iam_role.flow_logs[0].permissions_boundary == var.permissions_boundary_arn
    error_message = "the flow-log role sits under the workload path with the boundary"
  }

  # Only zones AgentCore Browser supports are asked for.
  assert {
    condition     = one([for filter in data.aws_availability_zones.available[0].filter : filter.values if filter.name == "zone-id"]) == toset(var.agentcore_az_ids)
    error_message = "the zone lookup must be limited to agentcore_az_ids"
  }
  assert {
    condition     = [for key, subnet in aws_subnet.app : subnet.availability_zone] == ["us-east-1b", "us-east-1c"]
    error_message = "the first az_count supported zones are used"
  }
  assert {
    condition     = output.agentcore_subnet_ids == tolist([aws_subnet.app["0"].id, aws_subnet.app["1"].id])
    error_message = "both app subnets are in supported zones"
  }

  # Rule matrix.
  assert {
    condition = toset(keys(aws_security_group.this)) == toset([
      "alb", "web", "worker", "browser_proxy", "studio_browser", "agent_runtime", "deploy_task", "db",
    ])
    error_message = "NAT mode has the eight workload groups and nothing else"
  }
  assert {
    condition = toset(keys(aws_vpc_security_group_ingress_rule.flow)) == toset([
      "alb-to-web-3000",
      "agent_runtime-to-alb-443",
      "agent_runtime-to-web-3000",
      "deploy_task-to-alb-443",
      "web-to-db-5432",
      "worker-to-db-5432",
      "browser_proxy-to-db-5432",
      "deploy_task-to-db-5432",
      "studio_browser-to-browser_proxy-3128",
    ])
    error_message = "group-to-group rules in NAT mode"
  }
  assert {
    condition     = keys(aws_vpc_security_group_egress_rule.flow) == keys(aws_vpc_security_group_ingress_rule.flow)
    error_message = "every group-to-group rule has both its egress and its ingress side"
  }
  assert {
    condition = toset(keys(aws_vpc_security_group_egress_rule.cidr)) == toset([
      "web-to-0.0.0.0/0-tcp-443",
      "worker-to-0.0.0.0/0-tcp-443",
      "agent_runtime-to-0.0.0.0/0-tcp-443",
      "deploy_task-to-0.0.0.0/0-tcp-443",
      "browser_proxy-to-0.0.0.0/0-tcp-80",
      "browser_proxy-to-0.0.0.0/0-tcp-443",
      "browser_proxy-to-10.10.0.2/32-udp-53",
      "browser_proxy-to-10.10.0.2/32-tcp-53",
      "studio_browser-to-10.10.0.2/32-udp-53",
      "studio_browser-to-10.10.0.2/32-tcp-53",
    ])
    error_message = "egress to address ranges in NAT mode"
  }
  assert {
    condition     = length(aws_vpc_security_group_egress_rule.s3) == 0
    error_message = "the S3 prefix-list rules belong to firewall mode"
  }
  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.flow["alb-to-web-3000"].security_group_id == aws_security_group.this["web"].id &&
      aws_vpc_security_group_ingress_rule.flow["alb-to-web-3000"].referenced_security_group_id == aws_security_group.this["alb"].id &&
      aws_vpc_security_group_ingress_rule.flow["alb-to-web-3000"].from_port == 3000 &&
      aws_vpc_security_group_egress_rule.flow["alb-to-web-3000"].security_group_id == aws_security_group.this["alb"].id &&
      aws_vpc_security_group_egress_rule.flow["alb-to-web-3000"].referenced_security_group_id == aws_security_group.this["web"].id
    )
    error_message = "a flow is an egress rule on its source and an ingress rule on its destination"
  }
  assert {
    condition = (
      aws_vpc_security_group_egress_rule.cidr["studio_browser-to-10.10.0.2/32-udp-53"].security_group_id == aws_security_group.this["studio_browser"].id &&
      aws_vpc_security_group_egress_rule.cidr["studio_browser-to-10.10.0.2/32-udp-53"].ip_protocol == "udp" &&
      aws_vpc_security_group_egress_rule.cidr["studio_browser-to-10.10.0.2/32-udp-53"].from_port == 53
    )
    error_message = "the Browser reaches the VPC resolver on 53"
  }
  assert {
    condition = (
      toset(keys(aws_vpc_security_group_ingress_rule.alb_https)) == toset(["0.0.0.0/0"]) &&
      toset(keys(aws_vpc_security_group_ingress_rule.alb_http)) == toset(["0.0.0.0/0"]) &&
      aws_vpc_security_group_ingress_rule.alb_https["0.0.0.0/0"].security_group_id == aws_security_group.this["alb"].id &&
      aws_vpc_security_group_ingress_rule.alb_https["0.0.0.0/0"].from_port == 443 &&
      aws_vpc_security_group_ingress_rule.alb_http["0.0.0.0/0"].from_port == 80
    )
    error_message = "the load balancer takes 443 and 80 from alb_ingress_cidrs"
  }
  assert {
    condition     = aws_security_group.this["browser_proxy"].name == "cmp-unit-browser-proxy"
    error_message = "group names follow the prefix"
  }

  assert {
    condition     = output.proxy_url == "" && length(aws_ecs_service.standin_proxy) == 0
    error_message = "NAT mode has no proxy"
  }
  assert {
    condition     = output.no_proxy == "s3.us-east-1.amazonaws.com,.s3.us-east-1.amazonaws.com,.us-east-1.elb.amazonaws.com,169.254.170.2,localhost,127.0.0.1,10.10.0.2"
    error_message = "NO_PROXY without interface endpoints"
  }
}

# --- create + firewall, with the stand-in proxy: the rehearsal -----------------------

run "create_firewall" {
  command = plan

  variables {
    mode                 = "create"
    vpc_cidr             = "10.10.0.0/16"
    firewall_mode        = true
    internal_alb         = true
    alb_ingress_cidrs    = ["10.0.0.0/8"]
    egress               = "proxy"
    create_standin_proxy = true
    proxy_allowlist      = ["api.example.com", ".example.org"]
  }

  # No internet route from the app subnets.
  assert {
    condition     = length(aws_route.app_default) == 0
    error_message = "the app route table must have no default route in firewall mode"
  }
  assert {
    condition = alltrue([
      for association in aws_route_table_association.app : association.route_table_id == aws_route_table.app[0].id
    ])
    error_message = "every app subnet uses the app route table"
  }
  assert {
    condition     = aws_route.public_default[0].route_table_id == aws_route_table.public[0].id && aws_route.public_default[0].gateway_id == aws_internet_gateway.this[0].id
    error_message = "the internet gateway route lives in the public route table only"
  }
  assert {
    condition = (
      length(aws_subnet.public) == 0 &&
      length(aws_route_table_association.public) == 0 &&
      aws_route_table_association.standin_public[0].subnet_id == aws_subnet.standin_public[0].id
    )
    error_message = "the public route table serves the stand-in's NAT subnet and nothing else"
  }
  assert {
    condition = (
      aws_nat_gateway.this[0].subnet_id == aws_subnet.standin_public[0].id &&
      aws_route.standin_proxy_default[0].route_table_id == aws_route_table.standin_proxy[0].id &&
      aws_route_table_association.standin_proxy[0].subnet_id == aws_subnet.standin_proxy[0].id
    )
    error_message = "only the stand-in proxy's subnet routes to the NAT gateway"
  }
  assert {
    condition     = aws_vpc_endpoint.s3[0].route_table_ids == toset([aws_route_table.app[0].id])
    error_message = "the S3 gateway endpoint serves the app route table"
  }

  # Endpoint list.
  assert {
    condition = keys(aws_vpc_endpoint.interface) == [
      "bedrock-agentcore",
      "bedrock-agentcore-control",
      "bedrock-runtime",
      "ecr.api",
      "ecr.dkr",
      "ecs",
      "ecs-agent",
      "ecs-telemetry",
      "kms",
      "logs",
      "monitoring",
      "secretsmanager",
      "ssm",
      "ssmmessages",
      "sts",
    ]
    error_message = "firewall mode creates the fifteen default interface endpoints"
  }
  assert {
    condition = alltrue([
      for endpoint in aws_vpc_endpoint.interface :
      endpoint.private_dns_enabled && endpoint.vpc_endpoint_type == "Interface" &&
      endpoint.security_group_ids == toset([aws_security_group.this["endpoints"].id])
    ])
    error_message = "interface endpoints use private DNS and the endpoint security group"
  }
  assert {
    condition     = data.aws_vpc_endpoint_service.interface["ecr.dkr"].service_name == "com.amazonaws.us-east-1.ecr.dkr"
    error_message = "service names are com.amazonaws.<region>.<service>"
  }

  # Rule matrix.
  assert {
    condition = toset(keys(aws_vpc_security_group_ingress_rule.flow)) == toset([
      "alb-to-web-3000",
      "agent_runtime-to-alb-443",
      "agent_runtime-to-web-3000",
      "deploy_task-to-alb-443",
      "web-to-db-5432",
      "worker-to-db-5432",
      "browser_proxy-to-db-5432",
      "deploy_task-to-db-5432",
      "studio_browser-to-browser_proxy-3128",
      "web-to-endpoints-443",
      "worker-to-endpoints-443",
      "browser_proxy-to-endpoints-443",
      "deploy_task-to-endpoints-443",
      "agent_runtime-to-endpoints-443",
      "standin_proxy-to-endpoints-443",
      "web-to-standin_proxy-3128",
      "worker-to-standin_proxy-3128",
      "browser_proxy-to-standin_proxy-3128",
      "agent_runtime-to-standin_proxy-3128",
    ])
    error_message = "group-to-group rules in firewall mode with the stand-in proxy"
  }
  assert {
    condition = toset(keys(aws_vpc_security_group_egress_rule.cidr)) == toset([
      "standin_proxy-to-0.0.0.0/0-tcp-80",
      "standin_proxy-to-0.0.0.0/0-tcp-443",
      "browser_proxy-to-10.10.0.2/32-udp-53",
      "browser_proxy-to-10.10.0.2/32-tcp-53",
      "studio_browser-to-10.10.0.2/32-udp-53",
      "studio_browser-to-10.10.0.2/32-tcp-53",
    ])
    error_message = "in firewall mode only the stand-in proxy has egress to the internet"
  }
  assert {
    condition     = toset(keys(aws_vpc_security_group_egress_rule.s3)) == toset(["web", "worker", "browser_proxy", "deploy_task"])
    error_message = "Fargate groups reach S3 through the gateway endpoint's prefix list"
  }
  assert {
    condition     = toset(keys(aws_vpc_security_group_ingress_rule.alb_https)) == toset(["10.0.0.0/8"])
    error_message = "the internal load balancer takes ingress from the stated ranges only"
  }

  # Stand-in proxy.
  assert {
    condition = (
      aws_ecs_service.standin_proxy[0].desired_count == 1 &&
      aws_ecs_service.standin_proxy[0].network_configuration[0].assign_public_ip == false &&
      aws_ecs_service.standin_proxy[0].network_configuration[0].subnets == toset([aws_subnet.standin_proxy[0].id]) &&
      aws_ecs_service.standin_proxy[0].network_configuration[0].security_groups == toset([aws_security_group.this["standin_proxy"].id])
    )
    error_message = "one stand-in task, without a public address, in the subnet that has the NAT route"
  }
  assert {
    condition     = strcontains(jsondecode(aws_ecs_task_definition.standin_proxy[0].container_definitions)[0].image, "@sha256:")
    error_message = "the squid image is pinned by digest"
  }
  assert {
    condition = strcontains(
      jsondecode(aws_ecs_task_definition.standin_proxy[0].container_definitions)[0].environment[0].value,
      "acl allowed_hosts dstdomain api.example.com .example.org\n",
    )
    error_message = "the allowlist reaches the squid configuration"
  }
  assert {
    condition     = aws_cloudwatch_log_group.standin_proxy[0].kms_key_id == var.logs_kms_key_arn
    error_message = "the proxy's log group is KMS-encrypted"
  }
  assert {
    condition     = output.proxy_url == "http://proxy.cmp-unit-egress.internal:3128"
    error_message = "proxy_url points at the stand-in"
  }
  assert {
    condition     = output.no_proxy == ".wildcard.us-east-1.amazonaws.com,service.us-east-1.amazonaws.com,s3.us-east-1.amazonaws.com,.s3.us-east-1.amazonaws.com,.us-east-1.elb.amazonaws.com,169.254.170.2,localhost,127.0.0.1,10.10.0.2"
    error_message = "NO_PROXY = endpoint names, S3, the load balancer suffix, the fixed entries, the resolver"
  }
}

# --- create + firewall behind the organisation's proxy ---------------------------------

run "create_firewall_with_external_proxy" {
  command = plan

  variables {
    mode                = "create"
    vpc_cidr            = "10.10.0.0/16"
    firewall_mode       = true
    internal_alb        = true
    alb_ingress_cidrs   = ["10.0.0.0/8"]
    egress              = "proxy"
    proxy_url           = "http://proxy.example.internal:8080"
    proxy_cidrs         = ["10.99.0.0/24"]
    interface_endpoints = ["logs", "sts"]
  }

  assert {
    condition     = length(aws_internet_gateway.this) == 0 && length(aws_nat_gateway.this) == 0 && length(aws_route.app_default) == 0
    error_message = "a firewalled VPC with an internal load balancer has no internet or NAT gateway"
  }
  assert {
    condition     = keys(aws_vpc_endpoint.interface) == ["logs", "sts"]
    error_message = "interface_endpoints overrides the default list"
  }
  assert {
    condition = toset(keys(aws_vpc_security_group_egress_rule.cidr)) == toset([
      "web-to-10.99.0.0/24-tcp-8080",
      "worker-to-10.99.0.0/24-tcp-8080",
      "browser_proxy-to-10.99.0.0/24-tcp-8080",
      "agent_runtime-to-10.99.0.0/24-tcp-8080",
      "browser_proxy-to-10.10.0.2/32-udp-53",
      "browser_proxy-to-10.10.0.2/32-tcp-53",
      "studio_browser-to-10.10.0.2/32-udp-53",
      "studio_browser-to-10.10.0.2/32-tcp-53",
    ])
    error_message = "the proxy port opens to the proxy's ranges only"
  }
  assert {
    condition     = output.proxy_url == "http://proxy.example.internal:8080" && length(aws_ecs_service.standin_proxy) == 0
    error_message = "proxy_url is passed through and no stand-in is built"
  }
}

# --- adopt: a landing zone's VPC ----------------------------------------------------

run "adopt" {
  command = plan

  variables {
    mode              = "adopt"
    vpc_id            = "vpc-0aaaaaaaaaaaaaaaa"
    app_subnet_ids    = ["subnet-0aaaaaaaaaaaaaaa1", "subnet-0aaaaaaaaaaaaaaa2"]
    data_subnet_ids   = ["subnet-0bbbbbbbbbbbbbbb1", "subnet-0bbbbbbbbbbbbbbb2"]
    firewall_mode     = true
    internal_alb      = true
    alb_ingress_cidrs = ["10.0.0.0/8"]
    egress            = "proxy"
    proxy_url         = "http://proxy.example.internal:8080"
    proxy_cidrs       = ["10.99.0.0/24"]
  }

  # The second app subnet is in a zone AgentCore Browser does not support.
  override_data {
    target = data.aws_subnet.app["subnet-0aaaaaaaaaaaaaaa2"]
    values = {
      availability_zone_id = "use1-az6"
    }
  }

  assert {
    condition = (
      length(aws_vpc.this) == 0 && length(aws_subnet.app) == 0 && length(aws_subnet.data) == 0 &&
      length(aws_route_table.app) == 0 && length(aws_route.app_default) == 0 &&
      length(aws_internet_gateway.this) == 0 && length(aws_nat_gateway.this) == 0 &&
      length(aws_vpc_endpoint.s3) == 0 && length(aws_flow_log.this) == 0
    )
    error_message = "adopt mode creates no VPC, subnet, route, gateway or flow log"
  }
  assert {
    condition = (
      output.vpc_id == "vpc-0aaaaaaaaaaaaaaaa" &&
      output.app_subnet_ids == tolist(["subnet-0aaaaaaaaaaaaaaa1", "subnet-0aaaaaaaaaaaaaaa2"]) &&
      output.data_subnet_ids == tolist(["subnet-0bbbbbbbbbbbbbbb1", "subnet-0bbbbbbbbbbbbbbb2"]) &&
      length(output.public_subnet_ids) == 0
    )
    error_message = "adopt mode passes the supplied ids through"
  }
  assert {
    condition     = output.agentcore_subnet_ids == tolist(["subnet-0aaaaaaaaaaaaaaa1"])
    error_message = "agentcore_subnet_ids keeps only subnets in a supported zone id"
  }
  assert {
    condition     = alltrue([for group in aws_security_group.this : group.vpc_id == "vpc-0aaaaaaaaaaaaaaaa"])
    error_message = "the security groups are created in the adopted VPC"
  }
  assert {
    condition = alltrue([
      for endpoint in aws_vpc_endpoint.interface :
      endpoint.vpc_id == "vpc-0aaaaaaaaaaaaaaaa" &&
      endpoint.subnet_ids == toset(["subnet-0aaaaaaaaaaaaaaa1", "subnet-0aaaaaaaaaaaaaaa2"])
    ])
    error_message = "interface endpoints go into the adopted app subnets"
  }
  assert {
    condition     = length(aws_vpc_endpoint.interface) == 15
    error_message = "firewall mode creates the interface endpoints in adopt mode too"
  }
  assert {
    condition     = contains(keys(aws_vpc_security_group_egress_rule.cidr), "studio_browser-to-10.20.0.2/32-udp-53")
    error_message = "the resolver address comes from the adopted VPC's CIDR"
  }
  assert {
    condition     = contains(keys(aws_vpc_security_group_ingress_rule.flow), "web-to-db-5432") && length(aws_vpc_security_group_ingress_rule.flow) == 14
    error_message = "the rule matrix is the same in adopt mode"
  }
}

# --- combinations the module refuses ------------------------------------------------------

run "firewall_mode_needs_proxy_egress" {
  command = plan

  variables {
    mode              = "create"
    vpc_cidr          = "10.10.0.0/16"
    firewall_mode     = true
    internal_alb      = true
    alb_ingress_cidrs = ["10.0.0.0/8"]
    egress            = "nat"
  }

  expect_failures = [var.firewall_mode]
}

run "internal_alb_refuses_open_ingress" {
  command = plan

  variables {
    mode              = "create"
    vpc_cidr          = "10.10.0.0/16"
    firewall_mode     = false
    internal_alb      = true
    alb_ingress_cidrs = ["0.0.0.0/0"]
    egress            = "nat"
  }

  expect_failures = [var.alb_ingress_cidrs]
}

run "proxy_egress_needs_a_proxy" {
  command = plan

  variables {
    mode              = "create"
    vpc_cidr          = "10.10.0.0/16"
    firewall_mode     = true
    internal_alb      = true
    alb_ingress_cidrs = ["10.0.0.0/8"]
    egress            = "proxy"
  }

  expect_failures = [var.proxy_url]
}

run "standin_proxy_refuses_adopt_mode" {
  command = plan

  variables {
    mode                 = "adopt"
    vpc_id               = "vpc-0aaaaaaaaaaaaaaaa"
    app_subnet_ids       = ["subnet-0aaaaaaaaaaaaaaa1"]
    data_subnet_ids      = ["subnet-0bbbbbbbbbbbbbbb1"]
    firewall_mode        = true
    internal_alb         = true
    alb_ingress_cidrs    = ["10.0.0.0/8"]
    egress               = "proxy"
    create_standin_proxy = true
    proxy_allowlist      = ["api.example.com"]
  }

  expect_failures = [var.create_standin_proxy]
}

run "create_mode_needs_enough_supported_zones" {
  command = plan

  variables {
    mode              = "create"
    vpc_cidr          = "10.10.0.0/16"
    az_count          = 4
    firewall_mode     = false
    internal_alb      = false
    alb_ingress_cidrs = ["0.0.0.0/0"]
    egress            = "nat"
  }

  expect_failures = [data.aws_availability_zones.available]
}
