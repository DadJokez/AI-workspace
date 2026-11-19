# Everything specific to personal-rehearsal: the firewall rehearsal of the
# migration spec's WP-19. It is created for a rehearsal and destroyed after it
# (scripts/rehearsal.sh up | run | report | down). Every stack reads this
# file; a stack ignores (with a warning) the values it does not declare.
#
# The profile is the firewall's: no internet route from the app subnets, every
# outbound request through a proxy that allows the hosts the egress inventory
# lists and nothing else, an internal load balancer, the AgentCore runtime in
# the VPC. The proxy is the stand-in of 10-network, because the rehearsal runs
# in the personal account, outside the organisation's network. Everything else
# is the smallest the stacks accept.
#
# PLACEHOLDERS: every REPLACE_ME value below is a placeholder, not real
# configuration. tf.sh refuses to run while a REPLACE_ME remains in this
# directory. Fill them on the machine that runs the rehearsal, mostly with the
# values of envs/personal-stage/env.tfvars, and keep the filled-in copy there:
# committed without placeholders, this environment would be planned by the
# plan workflow on pull requests, and it exists only during a rehearsal.

# --- common inputs -----------------------------------------------------------

env         = "personal-rehearsal"
name_prefix = "cmp-personal-rehearsal"
aws_region  = "us-east-1"
account_id  = "REPLACE_ME_ACCOUNT_ID"

tags = {
  "app"         = "comparative"
  "env"         = "personal-rehearsal"
  "owner"       = "REPLACE_ME_OWNER"
  "cost-center" = "REPLACE_ME_COST_CENTER"
  "data-class"  = "REPLACE_ME_DATA_CLASS"
  "managed-by"  = "terraform"
  "repo"        = "REPLACE_ME_GITHUB_OWNER/REPLACE_ME_GITHUB_REPO"
}

# --- 00-foundation -----------------------------------------------------------

# personal-stage owns the account's singletons (the evals role and the OIDC
# provider), so this environment creates neither and needs no eval models.
manage_account_singletons = false
create_oidc_provider      = false
manage_public_edge        = false

github_owner         = "REPLACE_ME_GITHUB_OWNER"
github_repo          = "REPLACE_ME_GITHUB_REPO"
github_owner_id      = "REPLACE_ME_GITHUB_OWNER_ID"
github_repository_id = "REPLACE_ME_GITHUB_REPOSITORY_ID"

# The account's state bucket and its key, as in envs/personal-stage.
state_bucket_name = "comparative-tfstate-REPLACE_ME_ACCOUNT_ID-us-east-1"
state_kms_key_arn = "REPLACE_ME_STATE_KMS_KEY_ARN"

eval_model_ids                = []
eval_inference_profile_prefix = "us."
eval_inference_regions        = ["us-east-1", "us-east-2", "us-west-2"]

# --- 10-network --------------------------------------------------------------

# Firewall mode: the app subnets have no default route; AWS APIs are reached
# through the interface endpoints, everything else through the stand-in
# proxy, which sits in the one subnet that has a NAT gateway.
network_mode         = "create"
firewall_mode        = true
egress               = "proxy"
create_standin_proxy = true

# A range of its own, clear of personal-stage's 10.64.0.0/16.
vpc_cidr = "10.65.0.0/16"

# Two zones is the least the stacks accept: the load balancer and the
# database subnet group each need subnets in two. The database itself is in
# one zone (db_multi_az below).
az_count = 2

# The load balancer is internal. Only the VPC reaches it; nothing outside the
# VPC routes to these addresses.
internal_alb      = true
alb_ingress_cidrs = ["10.65.0.0/16"]

agentcore_az_ids = ["use1-az1", "use1-az2", "use1-az4"]

# The hosts the stand-in proxy lets through: the proxy list of the egress
# inventory (apps/web/lib/egress-inventory.ts) for this environment's
# switches: the Koch set in extra_environment below, web search off
# (agentcore_web_search_provider and the app secret's WEB_SEARCH_PROVIDER),
# SES email, the AgentCore runtime and Studio Browser on, and INTERNAL_BASE_URL
# set. A host written `*.example.com` in the inventory is `.example.com` here
# (squid's form); a host such a domain already covers is left out.
#
# Generated: `infra/terraform/scripts/rehearsal.sh allowlist` rewrites the
# block between the two markers, and `rehearsal.sh allowlist --check` fails
# while it differs from the inventory. Do not edit it by hand.
# BEGIN proxy_allowlist
proxy_allowlist = [
  ".force.com",
  ".salesforce.com",
  "api.github.com",
  "api.githubcopilot.com",
  "email.us-east-1.amazonaws.com",
  "github.com",
]
# END proxy_allowlist

# --- 20-data -----------------------------------------------------------------

# The smallest instance, one zone, the shortest backups, a new empty database.
db_instance_class             = "db.t4g.micro"
db_multi_az                   = false
db_max_allocated_storage      = 21
db_backup_days                = 1
db_engine_version             = "16.13"
db_log_min_duration_statement = 1000
db_name                       = "comparative"
db_master_username            = "comparative_admin"

# Thrown away with the environment: no deletion protection, no final
# snapshot, secrets deleted without a recovery window and buckets emptied on
# destroy, so that `rehearsal.sh down` removes everything and the next
# rehearsal can reuse the names.
data_disposable = true

# --- 30-platform -------------------------------------------------------------

internal_namespace      = "personal-rehearsal.comparative.internal"
alb_deletion_protection = false

# The name the application believes it is served at (NEXTAUTH_URL is
# https://<domain_name>), and an ACM certificate for it in this region. No DNS
# record is needed: nothing outside the VPC can reach the load balancer.
domain_name     = "REPLACE_ME_DOMAIN_NAME"
certificate_arn = "REPLACE_ME_CERTIFICATE_ARN"

# --- 35-deploy-tasks and 40-services ---------------------------------------

# The internal load balancer's URL, https://<its DNS name>. It is known only
# once 30-platform is applied: rehearsal.sh up writes it here then, before it
# applies 35-deploy-tasks. Empty leaves INTERNAL_BASE_URL unset.
internal_base_url = ""

snapshot_keep_days = 1

# --- 50-agentcore ------------------------------------------------------------

# The runtime and the Studio Browser in the VPC, with the agent_runtime and
# studio_browser security groups of 10-network; the runtime receives the
# proxy settings 10-network publishes.
agentcore_network_mode         = "VPC"
agentcore_browser_network_mode = "VPC"

# Web search is off in the Koch switch set. The app secret's
# WEB_SEARCH_PROVIDER field must be "none" too.
agentcore_web_search_provider = "none"

# --- 40-services -------------------------------------------------------------

web_min           = 1
web_max           = 1
chat_worker_count = 1

# The magic-link check sends one sign-in email through SES, from an identity
# already verified in this account and region. While the account is in the
# SES sandbox, the recipient must be verified too.
invite_email_provider = "ses"
invite_email_from     = "REPLACE_ME_INVITE_EMAIL_FROM"
invite_email_identity = "REPLACE_ME_SES_IDENTITY"

bedrock_model_ids                = ["REPLACE_ME_BEDROCK_MODEL_ID"]
bedrock_inference_profile_prefix = "us."
bedrock_inference_regions        = ["us-east-1", "us-east-2", "us-west-2"]

agentcore_browser_enabled = true

# The Koch switch set (migration spec, WP-19), plus WEB_FETCH_ENABLED = "0":
# the URL fetch tool reaches any public host, which an allowlisting proxy
# cannot express. One value per line, as rehearsal.sh allowlist reads them.
extra_environment = {
  ENABLED_CONNECTOR_PROVIDERS = "salesforce,github"
  ANALYTICS_PROVIDER          = "none"
  GITHUB_EVENT_INGEST_MODE    = "poll"
  WEB_FETCH_ENABLED           = "0"
}

# --- 60-observability --------------------------------------------------------

alert_emails = ["REPLACE_ME_ALERT_EMAIL"]

# The account's Bedrock quota alarms belong to personal-stage.
quota_alarm_models = []
