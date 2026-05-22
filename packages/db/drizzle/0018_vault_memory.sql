CREATE TYPE "public"."memory_capture_status" AS ENUM('pending', 'processing', 'processed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."user_memory_status" AS ENUM('suggested', 'approved', 'dismissed', 'archived');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_capture_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	"thread_id" uuid NOT NULL REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action,
	"from_message_id" uuid NOT NULL REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action,
	"to_message_id" uuid NOT NULL REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action,
	"recipe_run_id" uuid REFERENCES "public"."recipe_runs"("id") ON DELETE set null ON UPDATE no action,
	"reason" text DEFAULT 'chat_turn' NOT NULL,
	"status" "memory_capture_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"claimed_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_memory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	"status" "user_memory_status" DEFAULT 'suggested' NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"body_md" text NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"source_thread_id" uuid REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action,
	"source_message_ids" jsonb,
	"suggested_by" text DEFAULT 'memory-capture' NOT NULL,
	"approved_by" uuid REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action,
	"approved_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_capture_queue_user_status_idx" ON "memory_capture_queue" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_capture_queue_thread_idx" ON "memory_capture_queue" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_capture_queue_recipe_run_idx" ON "memory_capture_queue" USING btree ("recipe_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memory_items_user_status_idx" ON "user_memory_items" USING btree ("user_id","status","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memory_items_user_category_idx" ON "user_memory_items" USING btree ("user_id","category","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memory_items_source_thread_idx" ON "user_memory_items" USING btree ("source_thread_id");
