# Shared helpers. Input is the output of `terraform show -json <plan>`.
#
# Every deny message starts with its rule id in brackets; check.sh uses the id
# to prove that a failing fixture fails for the stated reason.
package main

# Managed resources that exist after the plan is applied.
planned contains rc if {
	some rc in input.resource_changes
	rc.mode == "managed"
	rc.change.actions != ["delete"]
}

# True when the attribute has a non-empty value, or a value that is only known
# after apply (for example the ARN of a key created in the same plan).
attr_set(rc, attr) if {
	value := rc.change.after[attr]
	value != null
	value != ""
}

attr_set(rc, attr) if rc.change.after_unknown[attr] == true

# Resource blocks of every module in the configuration, as
# {"module": <path in the configuration>, "resource": <resource block>}.
configured contains entry if {
	some path, node
	walk(input.configuration, [path, node])
	is_object(node)
	some resource in node.resources
	resource.mode == "managed"
	entry := {"module": path, "resource": resource}
}

# True when a resource of type `kind`, in the same module as the configured
# bucket, sets its `bucket` argument from that bucket.
bucket_has_companion(entry, kind) if {
	some other in configured
	other.module == entry.module
	other.resource.type == kind
	some reference in other.resource.expressions.bucket.references
	reference == entry.resource.address
}

as_list(value) := value if is_array(value)

as_list(value) := [value] if not is_array(value)
