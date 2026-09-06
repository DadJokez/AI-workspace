-- #438 P0 (PR B): organization standing instructions get their own table.
-- Rob's decision (2026-09-06): the org layer must NOT live in the per-user
-- Vault table — user_memory_items.user_id cascades on user deletion, so
-- offboarding the admin who wrote the org document would silently delete
-- the organization's standing instructions. Here authored_by is provenance
-- only: ON DELETE SET NULL keeps the row and drops the attribution.
-- Every user reads approved rows; only admins write them
-- (apps/web/app/api/org-instructions/*). Additive only: new table, new FK,
-- new index; user_memory_items is untouched.
-- ORDERING: this is 0051 and must apply AFTER 0049 (#872) and 0050 (#870),
-- both applied in prod on 2026-09-06. The drizzle migrator applies journal
-- entries whose `when` exceeds the last applied one.
CREATE TABLE IF NOT EXISTS "org_instructions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"status" "user_memory_status" DEFAULT 'approved' NOT NULL,
	"authored_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_instructions" ADD CONSTRAINT "org_instructions_authored_by_users_id_fk" FOREIGN KEY ("authored_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_instructions_approved_idx" ON "org_instructions" USING btree ("created_at") WHERE "org_instructions"."status" = 'approved';
