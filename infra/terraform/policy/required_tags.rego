package main

# Every taggable resource carries the standard tags. They normally arrive
# through the provider's default_tags, which show up in tags_all.

required_tags := {"app", "env", "owner", "cost-center", "data-class", "managed-by", "repo"}

taggable(rc) if "tags_all" in object.keys(rc.change.after)

taggable(rc) if "tags_all" in object.keys(rc.change.after_unknown)

has_tag(rc, key) if {
	value := rc.change.after.tags_all[key]
	value != ""
}

# A tag whose value is only known after apply still counts as present.
has_tag(rc, _) if rc.change.after_unknown.tags_all == true

has_tag(rc, key) if rc.change.after_unknown.tags_all[key] == true

deny contains msg if {
	some rc in planned
	taggable(rc)
	missing := {key | some key in required_tags; not has_tag(rc, key)}
	count(missing) > 0
	msg := sprintf("[required-tags] %s is missing tags: %s", [rc.address, concat(", ", sort(missing))])
}
