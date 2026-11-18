# The release deployed to personal-stage: its id and its images, by digest.
# The release workflow replaces this whole file; nothing else belongs in it,
# and a deploy changes nothing else.
#
# PLACEHOLDERS: no release has been cut for this environment yet, so every
# REPLACE_ME value below is a placeholder, not an image. tf.sh refuses to run
# while a REPLACE_ME remains in this directory.

release_id = "REPLACE_ME_RELEASE_ID"

image_web           = "REPLACE_ME_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-app@sha256:REPLACE_ME_WEB_DIGEST"
image_worker        = "REPLACE_ME_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-app@sha256:REPLACE_ME_WORKER_DIGEST"
image_memory_worker = "REPLACE_ME_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-app@sha256:REPLACE_ME_MEMORY_WORKER_DIGEST"
image_migrator      = "REPLACE_ME_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-app@sha256:REPLACE_ME_MIGRATOR_DIGEST"
image_agent         = "REPLACE_ME_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-agent@sha256:REPLACE_ME_AGENT_DIGEST"
