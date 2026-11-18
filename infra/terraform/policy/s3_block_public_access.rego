package main

# Every bucket has a public access block, and every block turns all four
# settings on.

deny contains msg if {
	some entry in configured
	entry.resource.type == "aws_s3_bucket"
	not bucket_has_companion(entry, "aws_s3_bucket_public_access_block")
	msg := sprintf(
		"[s3-block-public-access] %s has no aws_s3_bucket_public_access_block in its module",
		[entry.resource.address],
	)
}

deny contains msg if {
	some rc in planned
	rc.type == "aws_s3_bucket_public_access_block"
	some setting in ["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"]
	not rc.change.after[setting] == true
	msg := sprintf("[s3-block-public-access] %s does not set %s = true", [rc.address, setting])
}
