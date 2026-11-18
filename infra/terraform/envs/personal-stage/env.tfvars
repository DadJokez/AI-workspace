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
