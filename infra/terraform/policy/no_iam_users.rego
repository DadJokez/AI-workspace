package main

# No long-lived credentials: identities are roles, never IAM users or access
# keys.
deny contains msg if {
	some rc in planned
	rc.type in {"aws_iam_user", "aws_iam_access_key"}
	msg := sprintf("[no-iam-users] %s: IAM users and access keys are not allowed", [rc.address])
}
