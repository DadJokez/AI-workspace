CREATE TYPE "public"."user_tool_attestation_scope" AS ENUM('provider', 'category', 'tool');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_tool_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope_type" "user_tool_attestation_scope" NOT NULL,
	"provider" text NOT NULL,
	"category" text,
	"tool_catalog_id" uuid,
	"tool_name" text,
	"action" "tool_catalog_action" DEFAULT 'read' NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_tool_attestations" ADD CONSTRAINT "user_tool_attestations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_tool_attestations" ADD CONSTRAINT "user_tool_attestations_tool_catalog_id_tools_catalog_id_fk" FOREIGN KEY ("tool_catalog_id") REFERENCES "public"."tools_catalog"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_tool_attestations" ADD CONSTRAINT "user_tool_attestations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_tool_attestations" ADD CONSTRAINT "user_tool_attestations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_tool_attestations_user_active_idx" ON "user_tool_attestations" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_tool_attestations_user_provider_idx" ON "user_tool_attestations" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_tool_attestations_user_category_idx" ON "user_tool_attestations" USING btree ("user_id","provider","category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_tool_attestations_user_tool_idx" ON "user_tool_attestations" USING btree ("user_id","provider","tool_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_tool_attestations_tool_catalog_idx" ON "user_tool_attestations" USING btree ("tool_catalog_id");
