# Canonical versions.tf. Every stacks/*/versions.tf is a byte-for-byte copy of
# this file; `./check.sh versions` fails when one drifts.
terraform {
  required_version = "~> 1.17"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
  }

  # bucket, region and kms_key_id come from envs/<env>/backend.hcl and the key
  # from tf.sh, so moving to another backend changes this block only.
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}
