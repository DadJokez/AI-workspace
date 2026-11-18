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

# --- 30-platform -------------------------------------------------------------

# Services are reached inside the VPC as <service>.<namespace>. Production's
# CDK stack holds comparative.internal in the same account, so this
# environment takes a name of its own.
internal_namespace = "personal-stage.comparative.internal"

# Stage is rebuilt freely, so its load balancer may be deleted. Every other
# environment sets true.
alb_deletion_protection = false

# The name users reach this environment at; the base URL is https://<name>.
domain_name = "REPLACE_ME_DOMAIN_NAME"

# An ACM certificate for domain_name that already exists in this region. The
# other way is to delete this line and set route53_zone_id to the hosted zone
# of domain_name: the stack then requests and validates the certificate and
# creates the DNS record itself, which the apply role can do only with
# manage_public_edge = true (above).
certificate_arn = "REPLACE_ME_CERTIFICATE_ARN"

# --- 40-services -------------------------------------------------------------

# One web task, growing to two under load; one task of each worker.
web_min           = 1
web_max           = 2
chat_worker_count = 1

# Invitation email goes out through SES from an identity that is already
# verified in this account and region.
invite_email_provider = "ses"
invite_email_from     = "REPLACE_ME_INVITE_EMAIL_FROM"
invite_email_identity = "REPLACE_ME_SES_IDENTITY"

# The services may invoke exactly these models: the inference profile
# <prefix><id> in aws_region and the foundation model in each routed region.
# Fill bedrock_model_ids with every foundation-model id the application can
# select, without the prefix.
bedrock_model_ids                = ["REPLACE_ME_BEDROCK_MODEL_ID"]
bedrock_inference_profile_prefix = "us."
bedrock_inference_regions        = ["us-east-1", "us-east-2", "us-west-2"]

# The web service offers the AgentCore Browser that 50-agentcore creates.
agentcore_browser_enabled = true

# The switches of the configuration contract (migration spec, section 2) that
# differ from the application's defaults, for web and both workers. Never a
# secret value: those are fields of the app secret.
extra_environment = {}

# --- 60-observability --------------------------------------------------------

# Who receives the alarms. AWS sends each address a confirmation email, and
# nothing is delivered to it until its owner confirms.
alert_emails = ["REPLACE_ME_ALERT_EMAIL"]

# Bedrock models whose daily token quota is watched; an alarm fires at 80 % of
# daily_quota. model_id is the ModelId dimension of the AWS/Bedrock metrics
# (the inference profile id), daily_quota the account's tokens-per-day quota
# for it in Service Quotas, output_burndown the quota tokens one output token
# costs. The first entry is what production watches today. The second is the
# model chat defaults to: its quota was never recorded, so it is a placeholder,
# and its model_id should be checked against the metrics the account emits.
# The quota belongs to the account: a second environment of the same account
# sets quota_alarm_models = [].
quota_alarm_models = [
  { model_id = "us.anthropic.claude-sonnet-4-5-20250929-v1:0", daily_quota = 5400000, output_burndown = 5 },
  { model_id = "us.anthropic.claude-sonnet-4-6", daily_quota = "REPLACE_ME_DAILY_TOKEN_QUOTA", output_burndown = 5 },
]
