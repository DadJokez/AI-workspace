package main

# No security-group ingress from the whole internet.
#
# The one exception is the load balancer's security group of an environment
# whose ALB is public (root variable internal_alb = false). The rule recognises
# that group by convention: the Terraform resource name of the security group,
# or of its ingress rule, starts with "alb" (aws_security_group.alb,
# aws_vpc_security_group_ingress_rule.alb_https). Without the variable, or with
# internal_alb = true, there is no exception.

open_cidrs := {"0.0.0.0/0", "::/0"}

alb_exempt(rc) if {
	startswith(rc.name, "alb")
	input.variables.internal_alb.value == false
}

open_ingress_cidrs(rc) := cidrs if {
	rc.type == "aws_vpc_security_group_ingress_rule"
	cidrs := {cidr |
		some attr in ["cidr_ipv4", "cidr_ipv6"]
		cidr := rc.change.after[attr]
		cidr in open_cidrs
	}
}

open_ingress_cidrs(rc) := cidrs if {
	rc.type == "aws_security_group_rule"
	rc.change.after.type == "ingress"
	cidrs := {cidr |
		some attr in ["cidr_blocks", "ipv6_cidr_blocks"]
		some cidr in rc.change.after[attr]
		cidr in open_cidrs
	}
}

open_ingress_cidrs(rc) := cidrs if {
	rc.type == "aws_security_group"
	cidrs := {cidr |
		some rule in rc.change.after.ingress
		some attr in ["cidr_blocks", "ipv6_cidr_blocks"]
		some cidr in rule[attr]
		cidr in open_cidrs
	}
}

deny contains msg if {
	some rc in planned
	some cidr in open_ingress_cidrs(rc)
	not alb_exempt(rc)
	msg := sprintf("[sg-no-open-ingress] %s allows ingress from %s", [rc.address, cidr])
}
