package main

# RDS, S3, log groups, secrets and ECR repositories are encrypted, the last
# three with a customer-managed key.

deny contains msg if {
	some rc in planned
	rc.type in {"aws_db_instance", "aws_rds_cluster"}
	not rc.change.after.storage_encrypted == true
	msg := sprintf("[encryption-at-rest] %s does not set storage_encrypted = true", [rc.address])
}

deny contains msg if {
	some entry in configured
	entry.resource.type == "aws_s3_bucket"
	not bucket_has_companion(entry, "aws_s3_bucket_server_side_encryption_configuration")
	msg := sprintf(
		"[encryption-at-rest] %s has no aws_s3_bucket_server_side_encryption_configuration in its module",
		[entry.resource.address],
	)
}

deny contains msg if {
	some rc in planned
	rc.type == "aws_cloudwatch_log_group"
	not attr_set(rc, "kms_key_id")
	msg := sprintf("[encryption-at-rest] %s has no kms_key_id", [rc.address])
}

deny contains msg if {
	some rc in planned
	rc.type == "aws_secretsmanager_secret"
	not attr_set(rc, "kms_key_id")
	msg := sprintf("[encryption-at-rest] %s has no kms_key_id", [rc.address])
}

ecr_uses_kms(rc) if {
	some encryption in rc.change.after.encryption_configuration
	encryption.encryption_type == "KMS"
}

deny contains msg if {
	some rc in planned
	rc.type == "aws_ecr_repository"
	not ecr_uses_kms(rc)
	msg := sprintf("[encryption-at-rest] %s is not encrypted with KMS", [rc.address])
}
