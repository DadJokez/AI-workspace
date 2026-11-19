-- User lifecycle (WP-18): an account can be suspended or deprovisioned without
-- deleting it, and every JWT issued before a suspension stops working.
--   status            active | suspended | deprovisioned. Only `active` may
--                     hold a session, sign in, or have runs executed.
--   session_version   stamped into the JWT at sign-in; bumped on suspend and
--                     deprovision, so older tokens no longer match the row.
--   status_changed_at when status last changed; NULL for an account that has
--                     never left `active`.
--   status_reason     the admin's free-text reason for the last change.
-- Expand-only: the constant defaults make every existing row `active` at
-- version 0 without rewriting the table, and the deployed code reads none of
-- these columns.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "session_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "status_changed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "status_reason" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_status_check" CHECK ("status" IN ('active', 'suspended', 'deprovisioned'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
