-- #438 P0 (PR B): organization standing instructions reuse the Vault table
-- (the #413 memory_items shape) with scope = 'org', so they get the same
-- add / edit / archive flow as personal memory. user_id on an org row is the
-- admin who authored it; every user reads only approved org rows, and only
-- admins may write them (apps/web/app/api/vault/memory/*).
-- Additive only: the DEFAULT stamps every existing row scope = 'user' with no
-- data UPDATE, no SET NOT NULL on an existing column, and no RENAME.
-- ORDERING: this is 0051 and must merge AFTER #872 (0049) and #870 (0050).
-- The drizzle migrator applies journal entries whose `when` exceeds the last
-- applied one, so landing this first would make those lower-`when`
-- migrations skip silently.
ALTER TABLE "user_memory_items" ADD COLUMN IF NOT EXISTS "scope" text NOT NULL DEFAULT 'user';--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_memory_items" ADD CONSTRAINT "user_memory_items_scope_check" CHECK ("scope" IN ('user', 'org'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memory_items_org_scope_idx" ON "user_memory_items" USING btree ("status","category","created_at") WHERE "user_memory_items"."scope" = 'org';
