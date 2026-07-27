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
	'notion',
	'Comparative Notion MCP',
	'Governed Notion workspace tools backed by each user''s delegated Notion grant.',
	'http'::"mcp_server_transport",
	'active'::"mcp_server_status",
	'https://comparative.builtwithrobot.link/api/mcp/notion',
	'delegated_oauth',
	jsonb_build_object('provider', 'notion', 'seededBy', '0040_notion_tools_catalog')
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
WITH notion_server AS (
	SELECT "id" FROM "mcp_servers" WHERE "slug" = 'notion'
),
seed_tools (
	"tool_name",
	"display_name",
	"description",
	"category",
	"action"
) AS (
	VALUES
		('search', 'Search Notion', 'Search shared Notion pages, notes, docs, and databases by title.', 'docs', 'read'::"tool_catalog_action"),
		('get_page', 'Read Notion page', 'Read one page''s metadata and visible properties.', 'docs', 'read'::"tool_catalog_action"),
		('get_page_markdown', 'Read Notion page content', 'Read a page''s full content as Markdown, including docs, wikis, and meeting notes.', 'docs', 'read'::"tool_catalog_action"),
		('get_page_property', 'Read Notion page property', 'Read one complete page property value, with pagination.', 'docs', 'read'::"tool_catalog_action"),
		('get_block_children', 'Read Notion blocks', 'Read the child blocks of a page or block.', 'docs', 'read'::"tool_catalog_action"),
		('get_database', 'Read Notion database', 'Read database metadata and its data source ids.', 'databases', 'read'::"tool_catalog_action"),
		('get_data_source', 'Read Notion data source', 'Read a data source schema and its properties.', 'databases', 'read'::"tool_catalog_action"),
		('query_data_source', 'Query Notion data source', 'Query rows in a database data source with filters and sorts.', 'databases', 'read'::"tool_catalog_action"),
		('append_text_block', 'Append Notion text', 'Append a plain text paragraph to a page.', 'docs', 'write'::"tool_catalog_action"),
		('append_blocks', 'Append Notion blocks', 'Append simple rich blocks to a page.', 'docs', 'write'::"tool_catalog_action"),
		('create_page', 'Create Notion page', 'Create a page or database row under a shared parent.', 'docs', 'write'::"tool_catalog_action"),
		('update_page_properties', 'Update Notion page properties', 'Update property values on a page or database row.', 'docs', 'write'::"tool_catalog_action"),
		('archive_page', 'Archive Notion page', 'Move a page to Notion trash or restore it.', 'docs', 'admin'::"tool_catalog_action"),
		('archive_block', 'Archive Notion block', 'Move a block to Notion trash.', 'docs', 'admin'::"tool_catalog_action")
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
	(SELECT "id" FROM notion_server),
	'notion',
	"tool_name",
	"display_name",
	"description",
	"category",
	"action",
	true,
	true,
	jsonb_build_object('seededBy', '0040_notion_tools_catalog')
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
