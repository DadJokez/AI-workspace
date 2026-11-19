# The release a firewall rehearsal runs: its id and its five images, each by
# digest. Nothing else belongs in this file.
#
# A rehearsal builds nothing. Before `rehearsal.sh up`, copy the release file
# of the environment being rehearsed, as it is:
#
#   cp infra/terraform/envs/personal-stage/release.auto.tfvars \
#      infra/terraform/envs/personal-rehearsal/release.auto.tfvars
#
# The images stay in personal-stage's repositories (same account); the task
# roles may pull from them. rehearsal.sh refuses to run `up` or `run` while this
# file sets no release_id. The copy, like the filled-in env.tfvars, stays on
# the machine that runs the rehearsal (see env.tfvars).
#
# release_id = "<commit sha>"
#
# image_web           = "<account>.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-app@sha256:<digest>"
# image_worker        = "<account>.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-app@sha256:<digest>"
# image_memory_worker = "<account>.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-app@sha256:<digest>"
# image_migrator      = "<account>.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-app@sha256:<digest>"
# image_agent         = "<account>.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-agent@sha256:<digest>"
