# Everything specific to personal-stage. Every stack reads this file; a stack
# ignores (with a warning) the values it does not declare.
#
# PLACEHOLDERS: every REPLACE_ME value below is a placeholder, not real
# configuration. tf.sh refuses to run while a REPLACE_ME remains in this
# directory.

# --- common inputs -----------------------------------------------------------

env         = "personal-stage"
name_prefix = "cmp-personal-stage"
aws_region  = "us-east-1"
account_id  = "REPLACE_ME_ACCOUNT_ID"

tags = {
  "app"         = "comparative"
  "env"         = "personal-stage"
  "owner"       = "REPLACE_ME_OWNER"
  "cost-center" = "REPLACE_ME_COST_CENTER"
  "data-class"  = "REPLACE_ME_DATA_CLASS"
  "managed-by"  = "terraform"
  "repo"        = "REPLACE_ME_GITHUB_OWNER/REPLACE_ME_GITHUB_REPO"
}

# --- 00-foundation -----------------------------------------------------------

# personal-stage is the first environment in the personal account, so it owns
# the per-account resources (the evals role, and the OIDC provider once
# create_oidc_provider is true).
manage_account_singletons = true

# false until WP-20: the account's GitHub OIDC provider is still owned by the
# CDK eval stack, so it is looked up, not created.
create_oidc_provider = false

# personal-stage has no Route 53, ACM or WAF resources of its own yet.
manage_public_edge = false

github_owner         = "REPLACE_ME_GITHUB_OWNER"
github_repo          = "REPLACE_ME_GITHUB_REPO"
github_owner_id      = "REPLACE_ME_GITHUB_OWNER_ID"
github_repository_id = "REPLACE_ME_GITHUB_REPOSITORY_ID"

# Outputs of bootstrap/.
state_bucket_name = "comparative-tfstate-REPLACE_ME_ACCOUNT_ID-us-east-1"
state_kms_key_arn = "REPLACE_ME_STATE_KMS_KEY_ARN"

# The evals role may invoke exactly these models: the inference profile
# <prefix><id> in aws_region and the foundation model in each routed region.
# Fill eval_model_ids with the foundation-model ids the eval harness uses.
eval_model_ids                = ["REPLACE_ME_EVAL_MODEL_ID"]
eval_inference_profile_prefix = "us."
eval_inference_regions        = ["us-east-1", "us-east-2", "us-west-2"]

# --- 10-network --------------------------------------------------------------

# The sandbox profile: a VPC of its own with one NAT gateway, no interface
# endpoints and a public load balancer.
network_mode  = "create"
firewall_mode = false
egress        = "nat"

# Range of the new VPC, a /16. It must stay clear of every network this VPC
# will be peered or routed with; changing it after the first apply replaces
# the VPC.
vpc_cidr = "10.64.0.0/16"

# Two zones: a load balancer and a database subnet group each need two.
az_count = 2

# The load balancer is public, as production's is today, so it takes HTTPS
# from anywhere. An internal load balancer lists the corporate ranges instead.
internal_alb      = false
alb_ingress_cidrs = ["0.0.0.0/0"]

# Zone ids (not names) AgentCore Browser supports in us-east-1. These are the
# migration spec's values and were not checked against AWS; check them before
# the first apply.
agentcore_az_ids = ["use1-az1", "use1-az2", "use1-az4"]

# --- 20-data -----------------------------------------------------------------

# The cheapest profile: one small instance, no standby, a week of backups.
db_instance_class        = "db.t4g.micro"
db_multi_az              = false
db_max_allocated_storage = 100
db_backup_days           = 7

# The migration spec's value for production's version; it was not checked
# against AWS. With the full version pinned here, an automatic minor upgrade by
# RDS shows as a difference until this value is raised to match; "16" follows
# the minor versions instead.
db_engine_version = "16.13"

# Statements slower than one second are logged.
db_log_min_duration_statement = 1000

# A new, empty database. To restore instead, set db_restore_snapshot_id before
# the first apply and make these two the snapshot's database name and master
# user: both are fixed at creation, and a different value plans a
# replacement of the instance.
db_name            = "comparative"
db_master_username = "comparative_admin"
