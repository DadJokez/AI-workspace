CREATE TYPE "public"."mcp_server_status" AS ENUM('active', 'disabled', 'planned');--> statement-breakpoint
CREATE TYPE "public"."mcp_server_transport" AS ENUM('http', 'sse', 'stdio');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"transport" "mcp_server_transport" NOT NULL,
	"status" "mcp_server_status" DEFAULT 'active' NOT NULL,
	"endpoint_url" text,
	"auth_mode" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tools_catalog" ADD COLUMN "mcp_server_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_servers_slug_idx" ON "mcp_servers" USING btree ("slug");--> statement-breakpoint
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
	'github',
	'GitHub MCP',
	'GitHub Copilot MCP server for repositories, issues, pull requests, and code search.',
	'http'::"mcp_server_transport",
	'active'::"mcp_server_status",
	'https://api.githubcopilot.com/mcp/',
	'delegated_oauth',
	jsonb_build_object('provider', 'github', 'seededBy', '0014_mcp_servers')
)
ON CONFLICT ("slug") DO UPDATE SET
	"display_name" = EXCLUDED."display_name",
	"description" = EXCLUDED."description",
	"transport" = EXCLUDED."transport",
	"status" = EXCLUDED."status",
	"endpoint_url" = EXCLUDED."endpoint_url",
	"auth_mode" = EXCLUDED."auth_mode",
	"metadata" = EXCLUDED."metadata",
	"updated_at" = now();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_servers_status_idx" ON "mcp_servers" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_servers_transport_idx" ON "mcp_servers" USING btree ("transport");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tools_catalog" ADD CONSTRAINT "tools_catalog_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tools_catalog_mcp_server_idx" ON "tools_catalog" USING btree ("mcp_server_id");
--> statement-breakpoint
UPDATE "tools_catalog"
SET "mcp_server_id" = (
	SELECT "id"
	FROM "mcp_servers"
	WHERE "slug" = "tools_catalog"."provider"
)
WHERE "mcp_server_id" IS NULL
	AND EXISTS (
		SELECT 1
		FROM "mcp_servers"
		WHERE "slug" = "tools_catalog"."provider"
	);
