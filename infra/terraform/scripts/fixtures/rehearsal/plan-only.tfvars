# What `rehearsal.sh --plan-only up` puts in place of each value of
# envs/personal-rehearsal that a human fills in or that up learns from AWS.
# Read after env.tfvars, so each line here replaces the variable whole.
# Stand-ins only: the documentation account id, example.com names, zero
# digests. rehearsal.sh refuses to plan while a variable that carries a
# REPLACE_ME in env.tfvars has no line here.

account_id = "111122223333"

tags = {
  "app"         = "comparative"
  "env"         = "personal-rehearsal"
  "owner"       = "plan-only"
  "cost-center" = "plan-only"
  "data-class"  = "plan-only"
  "managed-by"  = "terraform"
  "repo"        = "example/comparative"
}

github_owner         = "example"
github_repo          = "comparative"
github_owner_id      = "1"
github_repository_id = "2"

state_bucket_name = "comparative-tfstate-111122223333-us-east-1"
state_kms_key_arn = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-00000000000f"

domain_name     = "rehearsal.example.com"
certificate_arn = "arn:aws:acm:us-east-1:111122223333:certificate/00000000-0000-0000-0000-000000000000"

# What up writes once 30-platform is applied: the mocked load balancer's name
# in 30-platform.tftest.hcl.
internal_base_url = "https://internal-cmp-personal-rehearsal-alb-0123456789.us-east-1.elb.amazonaws.com"

invite_email_from     = "rehearsal@example.com"
invite_email_identity = "example.com"

bedrock_model_ids = ["vendor.model-a-v1:0"]

alert_emails = ["rehearsal@example.com"]

# The release: envs/personal-rehearsal/release.auto.tfvars is a copy of
# personal-stage's, made only for a real rehearsal.
release_id          = "0000000000000000000000000000000000000000"
image_web           = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-app@sha256:0000000000000000000000000000000000000000000000000000000000000001"
image_worker        = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-app@sha256:0000000000000000000000000000000000000000000000000000000000000002"
image_memory_worker = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-app@sha256:0000000000000000000000000000000000000000000000000000000000000003"
image_migrator      = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-app@sha256:0000000000000000000000000000000000000000000000000000000000000004"
image_agent         = "111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-personal-stage-agent@sha256:0000000000000000000000000000000000000000000000000000000000000005"
