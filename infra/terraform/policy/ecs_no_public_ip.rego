package main

# ECS services never get a public IP: tasks live in private subnets.
deny contains msg if {
	some rc in planned
	rc.type == "aws_ecs_service"
	some network in rc.change.after.network_configuration
	network.assign_public_ip == true
	msg := sprintf("[ecs-no-public-ip] %s sets assign_public_ip = true", [rc.address])
}
