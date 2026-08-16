ALTER TABLE "oauth_tokens" ADD COLUMN IF NOT EXISTS "granted_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN IF NOT EXISTS "revoked_by" uuid;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN IF NOT EXISTS "revocation_reason" text;--> statement-breakpoint
UPDATE "oauth_tokens" SET "granted_at" = "created_at" WHERE "granted_at" IS NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_tokens_active_idx" ON "oauth_tokens" USING btree ("user_id","revoked_at");--> statement-breakpoint

ALTER TABLE "user_tool_attestations" ADD COLUMN IF NOT EXISTS "revocation_reason" text;--> statement-breakpoint

ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "credential_type" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "credential_ttl_seconds" integer;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "last_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "enabled_by" uuid;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "disabled_by" uuid;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "status_reason" text;--> statement-breakpoint
UPDATE "mcp_servers"
SET
  "credential_type" = COALESCE("credential_type", "auth_mode"),
  "enabled_at" = COALESCE("enabled_at", "created_at")
WHERE "status" = 'active';--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_enabled_by_users_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_disabled_by_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_servers_owner_idx" ON "mcp_servers" USING btree ("owner_user_id");
