# Plan-only tests with a mocked AWS provider: no credentials, no AWS calls.
# The random provider is real; it only generates the ephemeral password.
#
# That no secret value reaches the plan JSON is checked by
# no_secret_in_plan.sh, which needs a plan file `terraform test` cannot give.

mock_provider "aws" {
  override_during = plan

  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }

  # Declaring a resource type here is what makes its computed attributes
  # available while planning. The proxy validates the ARNs it is given.
  mock_resource "aws_secretsmanager_secret" {
    defaults = {
      arn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/mock-AbCdEf"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111122223333:role/comparative/unit/cmp-unit-db-proxy"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {}
  }
}

variables {
  env         = "unit"
  name_prefix = "cmp-unit"
  aws_region  = "us-east-1"
  account_id  = "111122223333"

  data_subnet_ids      = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
  db_security_group_id = "sg-0aaaaaaaaaaaaaaaa"

  data_kms_key_arn         = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001"
  secrets_kms_key_arn      = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000002"
  permissions_boundary_arn = "arn:aws:iam::111122223333:policy/cmp-unit-workload-boundary"

  engine_version             = "16.13"
  instance_class             = "db.t4g.micro"
  multi_az                   = false
  max_allocated_storage      = 100
  backup_days                = 7
  log_min_duration_statement = 1000
  db_name                    = "comparative"
  master_username            = "comparative_admin"
}

# --- the database --------------------------------------------------------------

run "database" {
  command = plan

  assert {
    condition     = aws_db_instance.this.storage_encrypted == true && aws_db_instance.this.kms_key_id == var.data_kms_key_arn
    error_message = "storage must be encrypted with the data key"
  }
  assert {
    condition     = aws_db_instance.this.publicly_accessible == false
    error_message = "the database must not be publicly accessible"
  }
  assert {
    condition     = aws_db_instance.this.deletion_protection == true
    error_message = "deletion protection must be on"
  }
  assert {
    condition     = aws_db_instance.this.skip_final_snapshot == false && aws_db_instance.this.final_snapshot_identifier == "cmp-unit-db-final"
    error_message = "deleting the instance must leave a final snapshot"
  }
  assert {
    condition = (
      aws_db_instance.this.manage_master_user_password == true &&
      aws_db_instance.this.master_user_secret_kms_key_id == var.secrets_kms_key_arn &&
      aws_db_instance.this.password == null &&
      aws_db_instance.this.password_wo == null
    )
    error_message = "RDS must own the master password, encrypted with the secrets key; no password is an argument"
  }
  assert {
    condition = (
      aws_db_instance.this.identifier == "cmp-unit-db" &&
      aws_db_instance.this.engine == "postgres" &&
      aws_db_instance.this.engine_version == "16.13" &&
      aws_db_instance.this.instance_class == "db.t4g.micro" &&
      aws_db_instance.this.multi_az == false
    )
    error_message = "engine, version, class and multi-AZ come from the variables"
  }
  assert {
    condition = (
      aws_db_instance.this.storage_type == "gp3" &&
      aws_db_instance.this.allocated_storage == 20 &&
      aws_db_instance.this.max_allocated_storage == 100
    )
    error_message = "storage is gp3, 20 GB, autoscaling to max_allocated_storage"
  }
  assert {
    condition     = aws_db_instance.this.backup_retention_period == 7 && aws_db_instance.this.copy_tags_to_snapshot == true
    error_message = "backups are kept backup_days and snapshots carry the tags"
  }
  assert {
    condition = (
      aws_db_instance.this.performance_insights_enabled == true &&
      aws_db_instance.this.performance_insights_retention_period == 7 &&
      aws_db_instance.this.performance_insights_kms_key_id == var.data_kms_key_arn
    )
    error_message = "Performance Insights is on with the free 7-day retention and the data key"
  }
  assert {
    condition = (
      aws_db_instance.this.db_subnet_group_name == "cmp-unit-db" &&
      aws_db_subnet_group.this.subnet_ids == toset(var.data_subnet_ids) &&
      aws_db_instance.this.vpc_security_group_ids == toset([var.db_security_group_id])
    )
    error_message = "the instance sits in the data subnets with the database security group"
  }
  assert {
    condition = (
      aws_db_parameter_group.this.family == "postgres16" &&
      aws_db_instance.this.parameter_group_name == aws_db_parameter_group.this.name &&
      { for parameter in aws_db_parameter_group.this.parameter : parameter.name => parameter.value } == {
        "rds.force_ssl"              = "1"
        "log_min_duration_statement" = "1000"
      }
    )
    error_message = "the PostgreSQL 16 parameter group forces TLS and logs slow statements"
  }
}

run "restore_from_snapshot" {
  command = plan

  variables {
    restore_snapshot_id = "arn:aws:rds:us-east-1:111122223333:snapshot:before-cutover"
  }

  assert {
    condition     = aws_db_instance.this.snapshot_identifier == var.restore_snapshot_id
    error_message = "a new instance is restored from restore_snapshot_id"
  }
}

run "rejects_another_major_version" {
  command = plan

  variables {
    engine_version = "17.2"
  }

  expect_failures = [var.engine_version]
}

run "rejects_backups_off" {
  command = plan

  variables {
    backup_days = 0
  }

  expect_failures = [var.backup_days]
}

# --- the proxy -------------------------------------------------------------------

run "proxy_off_by_default" {
  command = plan

  assert {
    condition = (
      length(aws_db_proxy.this) == 0 &&
      length(aws_db_proxy_default_target_group.this) == 0 &&
      length(aws_db_proxy_target.this) == 0 &&
      length(aws_iam_role.db_proxy) == 0 &&
      length(aws_vpc_security_group_ingress_rule.db_from_proxy) == 0 &&
      length(aws_vpc_security_group_egress_rule.proxy_to_db) == 0
    )
    error_message = "there is no RDS Proxy, role or rule unless enable_rds_proxy is set"
  }
  assert {
    condition     = output.db_proxy_endpoint == null
    error_message = "without a proxy there is no proxy endpoint"
  }
  assert {
    condition     = sort(keys(aws_secretsmanager_secret.this)) == tolist(["app", "browser-proxy", "browser-proxy-db"])
    error_message = "without a proxy there are exactly three secrets"
  }
}

run "proxy_on" {
  command = plan

  variables {
    enable_rds_proxy = true
  }

  assert {
    condition = (
      aws_db_proxy.this[0].engine_family == "POSTGRESQL" &&
      aws_db_proxy.this[0].require_tls == true &&
      aws_db_proxy.this[0].vpc_subnet_ids == toset(var.data_subnet_ids) &&
      aws_db_proxy.this[0].vpc_security_group_ids == toset([var.db_security_group_id])
    )
    error_message = "the proxy requires TLS and sits in the data subnets with the database security group"
  }
  assert {
    condition     = aws_db_proxy_target.this[0].db_instance_identifier == "cmp-unit-db"
    error_message = "the proxy targets the instance"
  }
  assert {
    condition     = aws_secretsmanager_secret.this["db-proxy-auth"].name == "comparative/unit/db-proxy-auth"
    error_message = "the proxy's database login has a secret shell of its own"
  }
  assert {
    condition     = aws_iam_role.db_proxy[0].path == "/comparative/unit/" && aws_iam_role.db_proxy[0].permissions_boundary == var.permissions_boundary_arn
    error_message = "the proxy role sits under the workload path with the boundary"
  }
  assert {
    condition = [
      for statement in jsondecode(aws_iam_role_policy.db_proxy[0].policy).Statement : statement.Action
    ] == ["secretsmanager:GetSecretValue", "kms:Decrypt"]
    error_message = "the proxy role reads its one login and decrypts it, nothing else"
  }
  assert {
    condition = alltrue([
      for rule in [aws_vpc_security_group_ingress_rule.db_from_proxy[0], aws_vpc_security_group_egress_rule.proxy_to_db[0]] :
      rule.security_group_id == var.db_security_group_id &&
      rule.referenced_security_group_id == var.db_security_group_id &&
      rule.from_port == 5432 && rule.to_port == 5432 && rule.ip_protocol == "tcp"
    ])
    error_message = "the proxy reaches the instance on 5432 inside the database security group only"
  }
}

# --- secrets ---------------------------------------------------------------------

run "secrets" {
  command = plan

  assert {
    condition = { for name, secret in aws_secretsmanager_secret.this : name => secret.name } == {
      "app"              = "comparative/unit/app"
      "browser-proxy"    = "comparative/unit/browser-proxy"
      "browser-proxy-db" = "comparative/unit/browser-proxy-db"
    }
    error_message = "secrets are named comparative/<env>/<name>"
  }
  assert {
    condition     = alltrue([for secret in aws_secretsmanager_secret.this : secret.kms_key_id == var.secrets_kms_key_arn])
    error_message = "every secret is encrypted with the secrets key"
  }
  assert {
    condition = alltrue([
      for name, policy in aws_secretsmanager_secret_policy.this :
      policy.block_public_policy == true &&
      jsondecode(policy.policy).Statement == [{
        Sid       = "DenyOtherAccounts"
        Effect    = "Deny"
        Principal = "*"
        Action    = "secretsmanager:*"
        Resource  = "*"
        Condition = { StringNotEquals = { "aws:PrincipalAccount" = "111122223333" } }
      }]
    ])
    error_message = "every secret refuses other accounts and public policies"
  }
  assert {
    condition     = sort(keys(aws_secretsmanager_secret_policy.this)) == sort(keys(aws_secretsmanager_secret.this))
    error_message = "every secret has the resource policy"
  }

  # The one value Terraform writes goes through the write-only argument, which
  # is null in every plan and state.
  assert {
    condition = (
      aws_secretsmanager_secret_version.browser_proxy.secret_string == null &&
      aws_secretsmanager_secret_version.browser_proxy.secret_binary == null &&
      aws_secretsmanager_secret_version.browser_proxy.secret_string_wo == null &&
      aws_secretsmanager_secret_version.browser_proxy.secret_string_wo_version == 1
    )
    error_message = "the browser-proxy password must be written through secret_string_wo only"
  }
}

# --- buckets ---------------------------------------------------------------------

run "buckets" {
  command = plan

  assert {
    condition = (
      aws_s3_bucket.alb_logs.bucket == "cmp-unit-alb-logs-111122223333-us-east-1" &&
      aws_s3_bucket.artifacts.bucket == "cmp-unit-artifacts-111122223333-us-east-1"
    )
    error_message = "bucket names start with the name prefix and carry the account and region"
  }
  assert {
    condition = alltrue([
      for block in [aws_s3_bucket_public_access_block.alb_logs, aws_s3_bucket_public_access_block.artifacts] :
      block.block_public_acls && block.block_public_policy && block.ignore_public_acls && block.restrict_public_buckets
    ])
    error_message = "both buckets block all public access"
  }
  assert {
    condition = alltrue([
      for controls in [aws_s3_bucket_ownership_controls.alb_logs, aws_s3_bucket_ownership_controls.artifacts] :
      controls.rule[0].object_ownership == "BucketOwnerEnforced"
    ])
    error_message = "both buckets have ACLs disabled"
  }
  assert {
    condition = one([
      for rule in aws_s3_bucket_server_side_encryption_configuration.artifacts.rule :
      rule.apply_server_side_encryption_by_default[0]
    ]) == { sse_algorithm = "aws:kms", kms_master_key_id = var.data_kms_key_arn }
    error_message = "the artifacts bucket is encrypted with the data key"
  }
  assert {
    condition     = aws_s3_bucket_versioning.artifacts.versioning_configuration[0].status == "Enabled"
    error_message = "the artifacts bucket is versioned"
  }
  assert {
    condition = one([
      for rule in aws_s3_bucket_server_side_encryption_configuration.alb_logs.rule :
      rule.apply_server_side_encryption_by_default[0].sse_algorithm
    ]) == "AES256"
    error_message = "the access-log bucket uses S3-managed keys, the only kind log delivery supports"
  }
  assert {
    condition = (
      aws_s3_bucket_lifecycle_configuration.alb_logs.rule[0].status == "Enabled" &&
      aws_s3_bucket_lifecycle_configuration.alb_logs.rule[0].expiration[0].days == 30
    )
    error_message = "access logs expire after 30 days"
  }
  assert {
    condition = jsondecode(aws_s3_bucket_policy.alb_logs.policy).Statement == [{
      Sid       = "AllowApplicationLoadBalancerLogDelivery"
      Effect    = "Allow"
      Principal = { Service = "logdelivery.elasticloadbalancing.amazonaws.com" }
      Action    = "s3:PutObject"
      Resource  = "arn:aws:s3:::cmp-unit-alb-logs-111122223333-us-east-1/AWSLogs/111122223333/*"
      Condition = {
        StringEquals = { "aws:SourceAccount" = "111122223333" }
        ArnLike      = { "aws:SourceArn" = "arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/*" }
      }
    }]
    error_message = "only this account's load balancers in this region may write access logs, and only under AWSLogs/<account>/"
  }
}
