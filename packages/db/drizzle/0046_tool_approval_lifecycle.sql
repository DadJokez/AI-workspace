ALTER TYPE "public"."run_status" ADD VALUE IF NOT EXISTS 'waiting_for_approval' AFTER 'running';--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."tool_approval_status" AS ENUM('pending', 'approved', 'denied', 'expired');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tool_approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"provider" text,
	"endpoint" text,
	"native_tool_name" text,
	"call_fingerprint" text NOT NULL,
	"redacted_input" jsonb NOT NULL,
	"status" "tool_approval_status" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tool_approval_requests" ADD CONSTRAINT "tool_approval_requests_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tool_approval_requests" ADD CONSTRAINT "tool_approval_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tool_approval_requests" ADD CONSTRAINT "tool_approval_requests_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tool_approval_requests" ADD CONSTRAINT "tool_approval_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_approval_requests_run_status_idx" ON "tool_approval_requests" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_approval_requests_user_status_idx" ON "tool_approval_requests" USING btree ("user_id","status","requested_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_approval_requests_batch_idx" ON "tool_approval_requests" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_approval_requests_run_tool_call_idx" ON "tool_approval_requests" USING btree ("run_id","tool_call_id","call_fingerprint");
