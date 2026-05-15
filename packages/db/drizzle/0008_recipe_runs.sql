CREATE TYPE "public"."recipe_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'canceled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recipe_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"recipe_id" uuid,
	"recipe_slug" text,
	"thread_id" uuid,
	"trigger_type" text DEFAULT 'manual' NOT NULL,
	"status" "recipe_run_status" DEFAULT 'queued' NOT NULL,
	"runtime" text,
	"model_id" text,
	"inputs" jsonb,
	"outputs" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipe_runs" ADD CONSTRAINT "recipe_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recipe_runs" ADD CONSTRAINT "recipe_runs_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recipe_runs_user_idx" ON "recipe_runs" USING btree ("user_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recipe_runs_status_idx" ON "recipe_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recipe_runs_recipe_idx" ON "recipe_runs" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recipe_runs_thread_idx" ON "recipe_runs" USING btree ("thread_id");