INSERT INTO "user_tool_attestations" (
	"user_id",
	"scope_type",
	"provider",
	"action",
	"approved_at",
	"approved_by",
	"reason",
	"metadata"
)
SELECT DISTINCT
	ot."user_id",
	'provider'::"user_tool_attestation_scope",
	ot."provider",
	'admin'::"tool_catalog_action",
	now(),
	ot."user_id",
	'Migrated from existing connected OAuth provider.',
	jsonb_build_object('source', 'oauth_tokens_migration')
FROM "oauth_tokens" ot
WHERE NOT EXISTS (
	SELECT 1
	FROM "user_tool_attestations" uta
	WHERE uta."user_id" = ot."user_id"
		AND uta."scope_type" = 'provider'::"user_tool_attestation_scope"
		AND uta."provider" = ot."provider"
		AND uta."revoked_at" IS NULL
);
