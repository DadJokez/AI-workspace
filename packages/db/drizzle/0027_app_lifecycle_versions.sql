ALTER TABLE "shares" ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'viewer';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"summary" text,
	"created_by_user_id" uuid NOT NULL,
	"source_thread_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deployed_at" timestamp with time zone
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_edit_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"base_version_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);--> statement-breakpoint

ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_artifact_id_workspace_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."workspace_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_source_thread_id_chat_threads_id_fk" FOREIGN KEY ("source_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_edit_sessions" ADD CONSTRAINT "app_edit_sessions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_edit_sessions" ADD CONSTRAINT "app_edit_sessions_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_edit_sessions" ADD CONSTRAINT "app_edit_sessions_base_version_id_app_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."app_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_edit_sessions" ADD CONSTRAINT "app_edit_sessions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "app_versions_app_version_idx" ON "app_versions" USING btree ("app_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_versions_app_artifact_idx" ON "app_versions" USING btree ("app_id","artifact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_versions_app_status_idx" ON "app_versions" USING btree ("app_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_versions_app_created_idx" ON "app_versions" USING btree ("app_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_edit_sessions_app_status_idx" ON "app_edit_sessions" USING btree ("app_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_edit_sessions_thread_idx" ON "app_edit_sessions" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_edit_sessions_actor_active_idx" ON "app_edit_sessions" USING btree ("created_by_user_id","status");--> statement-breakpoint

ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "live_version_id" uuid;--> statement-breakpoint

INSERT INTO "app_versions" (
	"app_id",
	"artifact_id",
	"version_number",
	"status",
	"summary",
	"created_by_user_id",
	"source_thread_id",
	"created_at",
	"deployed_at"
)
SELECT
	"a"."id",
	"a"."live_artifact_id",
	1,
	CASE WHEN "a"."status" = 'deployed' THEN 'deployed' ELSE 'draft' END,
	'Initial app version backfilled from live_artifact_id.',
	"a"."owner_user_id",
	"a"."source_thread_id",
	"a"."created_at",
	CASE WHEN "a"."status" = 'deployed' THEN "a"."updated_at" ELSE NULL END
FROM "apps" "a"
WHERE "a"."live_artifact_id" IS NOT NULL
ON CONFLICT ("app_id", "artifact_id") DO NOTHING;--> statement-breakpoint

UPDATE "apps"
SET "live_version_id" = "v"."id"
FROM "app_versions" "v"
WHERE "apps"."live_version_id" IS NULL
	AND "v"."app_id" = "apps"."id"
	AND "v"."artifact_id" = "apps"."live_artifact_id";--> statement-breakpoint

ALTER TABLE "apps" ADD CONSTRAINT "apps_live_version_id_app_versions_id_fk" FOREIGN KEY ("live_version_id") REFERENCES "public"."app_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apps_live_version_idx" ON "apps" USING btree ("live_version_id");
