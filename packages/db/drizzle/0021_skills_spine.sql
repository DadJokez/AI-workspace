-- Skills Spine (specs/002-skills-spine): rename recipe_runs → runs and add
-- skills, schedules, shares, apps. Renames are metadata-only (instant); the
-- defensive UPDATE before each new FK guards against stray ids predating the
-- referenced tables.
ALTER TABLE "recipe_runs" RENAME TO "runs";--> statement-breakpoint
ALTER TABLE "runs" RENAME COLUMN "recipe_id" TO "skill_id";--> statement-breakpoint
ALTER TABLE "runs" RENAME COLUMN "recipe_slug" TO "skill_slug";--> statement-breakpoint
ALTER TABLE "run_events" RENAME COLUMN "recipe_run_id" TO "run_id";--> statement-breakpoint
ALTER TABLE "memory_capture_queue" RENAME COLUMN "recipe_run_id" TO "run_id";--> statement-breakpoint
ALTER TABLE "workspace_artifacts" RENAME COLUMN "recipe_run_id" TO "run_id";--> statement-breakpoint
ALTER TABLE "audit_log" RENAME COLUMN "recipe_run_id" TO "run_id";--> statement-breakpoint
ALTER TYPE "recipe_run_status" RENAME TO "run_status";--> statement-breakpoint
ALTER INDEX "recipe_runs_user_idx" RENAME TO "runs_user_idx";--> statement-breakpoint
ALTER INDEX "recipe_runs_status_idx" RENAME TO "runs_status_idx";--> statement-breakpoint
ALTER INDEX "recipe_runs_worker_claim_idx" RENAME TO "runs_worker_claim_idx";--> statement-breakpoint
ALTER INDEX "recipe_runs_recipe_idx" RENAME TO "runs_skill_idx";--> statement-breakpoint
ALTER INDEX "recipe_runs_thread_idx" RENAME TO "runs_thread_idx";--> statement-breakpoint
ALTER INDEX "memory_capture_queue_recipe_run_idx" RENAME TO "memory_capture_queue_run_idx";--> statement-breakpoint
ALTER INDEX "audit_log_recipe_run_idx" RENAME TO "audit_log_run_idx";--> statement-breakpoint
ALTER TABLE "runs" RENAME CONSTRAINT "recipe_runs_user_id_users_id_fk" TO "runs_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "runs" RENAME CONSTRAINT "recipe_runs_thread_id_chat_threads_id_fk" TO "runs_thread_id_chat_threads_id_fk";--> statement-breakpoint
ALTER TABLE "run_events" RENAME CONSTRAINT "run_events_recipe_run_id_recipe_runs_id_fk" TO "run_events_run_id_runs_id_fk";--> statement-breakpoint
ALTER TABLE "audit_log" RENAME CONSTRAINT "audit_log_recipe_run_id_recipe_runs_id_fk" TO "audit_log_run_id_runs_id_fk";--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "runs" RENAME CONSTRAINT "recipe_runs_pkey" TO "runs_pkey";
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "memory_capture_queue" RENAME CONSTRAINT "memory_capture_queue_recipe_run_id_fkey" TO "memory_capture_queue_run_id_runs_id_fk";
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "workspace_artifacts" RENAME CONSTRAINT "workspace_artifacts_recipe_run_id_fkey" TO "workspace_artifacts_run_id_runs_id_fk";
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_user_id" uuid NOT NULL,
	"system_prompt" text NOT NULL,
	"model_id" text NOT NULL,
	"mcp_providers" jsonb NOT NULL,
	"params_schema" jsonb,
	"visibility" text DEFAULT 'private' NOT NULL,
	"cloned_from_skill_id" uuid,
	"is_starter" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"cadence" text NOT NULL,
	"timezone" text NOT NULL,
	"target_thread_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"granted_to_user_id" uuid NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_user_id" uuid NOT NULL,
	"live_artifact_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"source_thread_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_cloned_from_skill_id_skills_id_fk" FOREIGN KEY ("cloned_from_skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_target_thread_id_chat_threads_id_fk" FOREIGN KEY ("target_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_granted_to_user_id_users_id_fk" FOREIGN KEY ("granted_to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_live_artifact_id_workspace_artifacts_id_fk" FOREIGN KEY ("live_artifact_id") REFERENCES "public"."workspace_artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_source_thread_id_chat_threads_id_fk" FOREIGN KEY ("source_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
UPDATE "runs" SET "skill_id" = NULL WHERE "skill_id" IS NOT NULL AND "skill_id" NOT IN (SELECT "id" FROM "skills");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skills_slug_idx" ON "skills" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_owner_idx" ON "skills" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_starter_idx" ON "skills" USING btree ("is_starter");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedules_due_idx" ON "schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedules_user_idx" ON "schedules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedules_skill_idx" ON "schedules" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shares_active_grant_idx" ON "shares" USING btree ("subject_type","subject_id","granted_to_user_id") WHERE "shares"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shares_subject_idx" ON "shares" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shares_grantee_idx" ON "shares" USING btree ("granted_to_user_id","subject_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apps_slug_idx" ON "apps" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apps_owner_idx" ON "apps" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_schedule_idx" ON "runs" USING btree ("schedule_id");
