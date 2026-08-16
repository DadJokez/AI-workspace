ALTER TABLE "tool_approval_requests" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "tool_approval_requests"
SET "expires_at" = "requested_at" + interval '24 hours'
WHERE "expires_at" IS NULL;--> statement-breakpoint
ALTER TABLE "tool_approval_requests" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_approval_requests_expiry_idx" ON "tool_approval_requests" USING btree ("status","expires_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_tool_standing_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"native_tool_name" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skill_tool_standing_approvals" ADD CONSTRAINT "skill_tool_standing_approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skill_tool_standing_approvals" ADD CONSTRAINT "skill_tool_standing_approvals_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skill_tool_standing_approvals" ADD CONSTRAINT "skill_tool_standing_approvals_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skill_tool_standing_approvals" ADD CONSTRAINT "skill_tool_standing_approvals_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_tool_standing_approvals_scope_idx" ON "skill_tool_standing_approvals" USING btree ("user_id","skill_id","provider","endpoint","native_tool_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_tool_standing_approvals_active_idx" ON "skill_tool_standing_approvals" USING btree ("user_id","skill_id","expires_at");
