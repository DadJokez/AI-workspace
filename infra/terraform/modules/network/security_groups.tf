# Security groups of every workload, in both modes. Terraform owns every rule:
# the groups carry no inline rules, so a rule added by hand shows up as drift.
#
# Rules between two groups are written once, as a flow, and become an egress
# rule on the source and an ingress rule on the destination. Nothing here opens
# ingress from an address range except the load balancer's own rules, whose
# resource names start with "alb" (the convention policy/sg_no_open_ingress.rego
# relies on).

locals {
  proxy_port = var.create_standin_proxy ? 3128 : (
    var.proxy_url == "" ? null : tonumber(regex(":([0-9]+)$", var.proxy_url)[0])
  )

  security_groups = merge(
    {
      alb            = "Load balancer"
      web            = "Web service"
      worker         = "Background workers"
      browser_proxy  = "Governed egress proxy of the AgentCore Browser"
      studio_browser = "AgentCore Browser, restricted to its proxy and VPC DNS"
      agent_runtime  = "AgentCore Runtime"
      deploy_task    = "Migrator and smoke tasks"
      db             = "Database"
    },
    var.firewall_mode ? { endpoints = "Interface endpoints" } : {},
    var.create_standin_proxy ? { standin_proxy = "Stand-in forward proxy" } : {},
  )

  # Groups whose tasks start on Fargate: they pull their image and write their
  # logs through the task's own network interface.
  fargate_groups = ["web", "worker", "browser_proxy", "deploy_task"]

  # Groups that send application traffic through the forward proxy.
  proxied_groups = ["web", "worker", "browser_proxy", "agent_runtime"]

  # [source, destination, tcp port]
  flows = concat(
    [
      ["alb", "web", 3000],
      # The runtime calls the MCP facades over the internal base URL: through
      # the load balancer, or straight to the web tasks.
      ["agent_runtime", "alb", 443],
      ["agent_runtime", "web", 3000],
      # The smoke task calls the base URL.
      ["deploy_task", "alb", 443],
      ["web", "db", 5432],
      ["worker", "db", 5432],
      ["browser_proxy", "db", 5432],
      ["deploy_task", "db", 5432],
      ["studio_browser", "browser_proxy", 3128],
    ],
    var.firewall_mode ? [
      for group in concat(local.fargate_groups, ["agent_runtime"], var.create_standin_proxy ? ["standin_proxy"] : []) :
      [group, "endpoints", 443]
    ] : [],
    var.create_standin_proxy ? [for group in local.proxied_groups : [group, "standin_proxy", 3128]] : [],
  )

  flow_rules = {
    for flow in local.flows : "${flow[0]}-to-${flow[1]}-${flow[2]}" => {
      source      = flow[0]
      destination = flow[1]
      port        = flow[2]
    }
  }

  # Egress to address ranges.
  cidr_egress = concat(
    # Sandbox: the NAT gateway is the way out.
    var.egress == "nat" ? concat(
      [for group in ["web", "worker", "agent_runtime", "deploy_task"] : { group = group, cidr = "0.0.0.0/0", protocol = "tcp", port = 443 }],
      [for port in [80, 443] : { group = "browser_proxy", cidr = "0.0.0.0/0", protocol = "tcp", port = port }],
    ) : [],
    # The organisation's proxy: its port, to its ranges, and nothing else.
    [for pair in setproduct(local.proxied_groups, var.proxy_cidrs) : { group = pair[0], cidr = pair[1], protocol = "tcp", port = local.proxy_port }],
    # The stand-in is the one workload that reaches the internet in firewall mode.
    var.create_standin_proxy ? [for port in [80, 443] : { group = "standin_proxy", cidr = "0.0.0.0/0", protocol = "tcp", port = port }] : [],
    # VPC DNS, stated for the two groups whose egress is otherwise closed.
    [for pair in setproduct(["browser_proxy", "studio_browser"], ["udp", "tcp"]) : { group = pair[0], cidr = "${local.resolver_ip}/32", protocol = pair[1], port = 53 }],
  )

  cidr_egress_rules = {
    for rule in local.cidr_egress : "${rule.group}-to-${rule.cidr}-${rule.protocol}-${rule.port}" => rule
  }
}

resource "aws_security_group" "this" {
  #checkov:skip=CKV2_AWS_5:The groups are attached by the stacks that own the workloads; this stack publishes their ids
  for_each = local.security_groups

  name        = "${var.name_prefix}-${replace(each.key, "_", "-")}"
  description = "Comparative ${var.env}: ${each.value}"
  vpc_id      = local.vpc_id

  tags = { Name = "${var.name_prefix}-${replace(each.key, "_", "-")}" }
}

# --- load balancer ingress ------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each = toset(var.alb_ingress_cidrs)

  security_group_id = aws_security_group.this["alb"].id
  description       = "HTTPS from ${each.value}"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  for_each = toset(var.alb_ingress_cidrs)

  security_group_id = aws_security_group.this["alb"].id
  description       = "HTTP from ${each.value}, redirected to HTTPS"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

# --- group to group -------------------------------------------------------------

resource "aws_vpc_security_group_egress_rule" "flow" {
  for_each = local.flow_rules

  security_group_id            = aws_security_group.this[each.value.source].id
  description                  = "${each.value.port} to ${each.value.destination}"
  referenced_security_group_id = aws_security_group.this[each.value.destination].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}

resource "aws_vpc_security_group_ingress_rule" "flow" {
  for_each = local.flow_rules

  security_group_id            = aws_security_group.this[each.value.destination].id
  description                  = "${each.value.port} from ${each.value.source}"
  referenced_security_group_id = aws_security_group.this[each.value.source].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}

# --- egress to address ranges -----------------------------------------------------

resource "aws_vpc_security_group_egress_rule" "cidr" {
  for_each = local.cidr_egress_rules

  security_group_id = aws_security_group.this[each.value.group].id
  description       = "${each.value.protocol} ${each.value.port} to ${each.value.cidr}"
  cidr_ipv4         = each.value.cidr
  ip_protocol       = each.value.protocol
  from_port         = each.value.port
  to_port           = each.value.port
}

# Firewall mode: image layers come from S3 through the gateway endpoint.
resource "aws_vpc_security_group_egress_rule" "s3" {
  for_each = var.firewall_mode ? toset(local.fargate_groups) : toset([])

  security_group_id = aws_security_group.this[each.value].id
  description       = "443 to S3 through the gateway endpoint"
  prefix_list_id    = data.aws_ec2_managed_prefix_list.s3.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
