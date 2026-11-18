package main

# Every container of an ECS task definition names its image by digest: a tag
# can be moved to another image, a digest cannot.
#
# Limit: container definitions that are only known after apply cannot be read
# from the plan and are not checked here.
deny contains msg if {
	some rc in planned
	rc.type == "aws_ecs_task_definition"
	some container in json.unmarshal(rc.change.after.container_definitions)
	not regex.match(`@sha256:[0-9a-f]{64}$`, container.image)
	msg := sprintf(
		"[ecs-image-by-digest] %s: container %q runs image %q, which is not given by digest",
		[rc.address, container.name, container.image],
	)
}
