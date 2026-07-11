INSERT INTO "mcp_servers" (
	"slug",
	"display_name",
	"description",
	"transport",
	"status",
	"endpoint_url",
	"auth_mode",
	"metadata"
)
VALUES (
	'salesforce',
	'Comparative Salesforce MCP',
	'Governed read-only Salesforce tools backed by each user''s delegated Salesforce grant.',
	'http'::"mcp_server_transport",
	'active'::"mcp_server_status",
	'https://comparative.builtwithrobot.link/api/mcp/salesforce',
	'delegated_oauth',
	jsonb_build_object('provider', 'salesforce', 'seededBy', '0035_salesforce_tools_catalog')
)
ON CONFLICT ("slug") DO UPDATE SET
	"display_name" = EXCLUDED."display_name",
	"description" = EXCLUDED."description",
	"transport" = EXCLUDED."transport",
	"status" = EXCLUDED."status",
	"endpoint_url" = EXCLUDED."endpoint_url",
	"auth_mode" = EXCLUDED."auth_mode",
	"metadata" = COALESCE("mcp_servers"."metadata", '{}'::jsonb) || EXCLUDED."metadata",
	"updated_at" = now();
--> statement-breakpoint
WITH salesforce_server AS (
	SELECT "id" FROM "mcp_servers" WHERE "slug" = 'salesforce'
),
seed_tools (
	"tool_name",
	"display_name",
	"description",
	"category",
	"action"
) AS (
	VALUES
		('search_records', 'Search Salesforce records', 'Search records by text across common objects.', 'crm', 'read'::"tool_catalog_action"),
		('run_soql', 'Run read-only SOQL', 'Run a server-validated SELECT-only SOQL query.', 'crm', 'read'::"tool_catalog_action"),
		('describe_object', 'Describe Salesforce object', 'Read one object''s fields and relationships.', 'crm', 'read'::"tool_catalog_action"),
		('get_record', 'Read Salesforce record', 'Read one record by object name and id.', 'crm', 'read'::"tool_catalog_action")
)
INSERT INTO "tools_catalog" (
	"mcp_server_id",
	"provider",
	"tool_name",
	"display_name",
	"description",
	"category",
	"action",
	"requires_attestation",
	"enabled",
	"metadata"
)
SELECT
	(SELECT "id" FROM salesforce_server),
	'salesforce',
	"tool_name",
	"display_name",
	"description",
	"category",
	"action",
	true,
	true,
	jsonb_build_object('seededBy', '0035_salesforce_tools_catalog')
FROM seed_tools
ON CONFLICT ("provider", "tool_name") DO UPDATE SET
	"mcp_server_id" = COALESCE("tools_catalog"."mcp_server_id", EXCLUDED."mcp_server_id"),
	"display_name" = EXCLUDED."display_name",
	"description" = EXCLUDED."description",
	"category" = EXCLUDED."category",
	"action" = EXCLUDED."action",
	"requires_attestation" = EXCLUDED."requires_attestation",
	"enabled" = EXCLUDED."enabled",
	"metadata" = COALESCE("tools_catalog"."metadata", '{}'::jsonb) || EXCLUDED."metadata",
	"updated_at" = now();
