CREATE TYPE "public"."audit_log_status" AS ENUM('started', 'succeeded', 'failed', 'denied');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action_type" text NOT NULL,
	"status" "audit_log_status" NOT NULL,
	"provider" text,
	"tool_name" text,
	"tool_call_id" text,
	"chat_thread_id" uuid,
	"chat_message_id" uuid,
	"recipe_run_id" uuid,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"metadata" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_chat_message_id_chat_messages_id_fk" FOREIGN KEY ("chat_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_recipe_run_id_recipe_runs_id_fk" FOREIGN KEY ("recipe_run_id") REFERENCES "public"."recipe_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_action_idx" ON "audit_log" USING btree ("action_type","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_status_idx" ON "audit_log" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_provider_tool_idx" ON "audit_log" USING btree ("provider","tool_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_chat_message_idx" ON "audit_log" USING btree ("chat_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_recipe_run_idx" ON "audit_log" USING btree ("recipe_run_id");