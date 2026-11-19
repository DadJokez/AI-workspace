# The release deployed to personal-stage: its id and its five images, each by
# digest. The release workflow replaces this whole file; nothing else belongs
# in it, and a deploy changes nothing else.
#
# No release has been cut for this environment yet, so the file sets nothing
# and 35-deploy-tasks, 50-agentcore and 40-services cannot be planned. The
# first release writes these six values (the stacks refuse an image given by
# tag):
#
# release_id = "<commit sha>"
#
# image_web           = "<account>.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-app@sha256:<digest>"
# image_worker        = "<account>.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-app@sha256:<digest>"
# image_memory_worker = "<account>.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-app@sha256:<digest>"
# image_migrator      = "<account>.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-app@sha256:<digest>"
# image_agent         = "<account>.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-agent@sha256:<digest>"
