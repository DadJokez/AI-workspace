package main

# No identity policy may allow every Bedrock action (bedrock:*, or a bare *),
# and bedrock:InvokeModel* is never allowed on Resource "*": model access is
# always a list of model and inference-profile ARNs.
#
# Limit: a policy document that is only known after apply cannot be read from
# the plan and is not checked here.

iam_policy_types := {"aws_iam_policy", "aws_iam_role_policy", "aws_iam_group_policy"}

allow_statements contains [rc.address, statement] if {
	some rc in planned
	rc.type in iam_policy_types
	document := json.unmarshal(rc.change.after.policy)
	some statement in as_list(document.Statement)
	statement.Effect == "Allow"
}

# IAM actions are case-insensitive and may contain * and ? wildcards.
action_matches(action, name) if glob.match(lower(action), [], lower(name))

invokes_models(action) if {
	some name in ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
	action_matches(action, name)
}

deny contains msg if {
	some [address, statement] in allow_statements
	some action in as_list(statement.Action)
	lower(action) in {"*", "bedrock:*"}
	msg := sprintf("[iam-bedrock-scope] %s allows action %q, which grants every Bedrock action", [address, action])
}

deny contains msg if {
	some [address, statement] in allow_statements
	some action in as_list(statement.Action)
	invokes_models(action)
	some resource in as_list(statement.Resource)
	resource == "*"
	msg := sprintf("[iam-bedrock-scope] %s allows %q on Resource \"*\"", [address, action])
}
