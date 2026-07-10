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
	'google',
	'Comparative Google MCP',
	'Governed Gmail and Google Calendar tools backed by each user''s delegated Google grant.',
	'http'::"mcp_server_transport",
	'active'::"mcp_server_status",
	'https://comparative.builtwithrobot.link/api/mcp/google',
	'delegated_oauth',
	jsonb_build_object('provider', 'google', 'seededBy', '0032_google_tools_catalog')
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
WITH google_server AS (
	SELECT "id" FROM "mcp_servers" WHERE "slug" = 'google'
),
seed_tools (
	"tool_name",
	"display_name",
	"description",
	"category",
	"action"
) AS (
	VALUES
		('search_mail', 'Search Gmail', 'Search Gmail messages using Gmail query syntax.', 'mail', 'read'::"tool_catalog_action"),
		('get_message', 'Read Gmail message', 'Read one Gmail message and its visible body.', 'mail', 'read'::"tool_catalog_action"),
		('get_thread', 'Read Gmail thread', 'Read the messages in one Gmail thread.', 'mail', 'read'::"tool_catalog_action"),
		('create_draft', 'Create Gmail draft', 'Save a native Gmail draft without sending it.', 'mail', 'write'::"tool_catalog_action"),
		('list_calendars', 'List calendars', 'List calendars visible to the connected account.', 'calendar', 'read'::"tool_catalog_action"),
		('list_events', 'List calendar events', 'Read events in a calendar time range.', 'calendar', 'read'::"tool_catalog_action"),
		('get_event', 'Read calendar event', 'Read one Google Calendar event.', 'calendar', 'read'::"tool_catalog_action"),
		('query_free_busy', 'Read free busy', 'Read free and busy windows for calendars.', 'calendar', 'read'::"tool_catalog_action"),
		('prepare_event', 'Prepare calendar event', 'Prepare a no-write event proposal for user confirmation.', 'calendar', 'read'::"tool_catalog_action"),
		('create_event', 'Create calendar event', 'Create an exact previously confirmed event with idempotency.', 'calendar', 'write'::"tool_catalog_action")
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
	(SELECT "id" FROM google_server),
	'google',
	"tool_name",
	"display_name",
	"description",
	"category",
	"action",
	true,
	true,
	jsonb_build_object('seededBy', '0032_google_tools_catalog')
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
