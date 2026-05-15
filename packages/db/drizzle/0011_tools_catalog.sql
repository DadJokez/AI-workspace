CREATE TYPE "public"."tool_catalog_action" AS ENUM('read', 'write', 'admin');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tools_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"tool_name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'general' NOT NULL,
	"action" "tool_catalog_action" DEFAULT 'read' NOT NULL,
	"requires_attestation" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tools_catalog_provider_tool_idx" ON "tools_catalog" USING btree ("provider","tool_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tools_catalog_provider_idx" ON "tools_catalog" USING btree ("provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tools_catalog_category_idx" ON "tools_catalog" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tools_catalog_enabled_idx" ON "tools_catalog" USING btree ("enabled");