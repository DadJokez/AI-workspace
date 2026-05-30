CREATE TABLE IF NOT EXISTS "workspace_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	"thread_id" uuid REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action,
	"chat_message_id" uuid REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action,
	"recipe_run_id" uuid REFERENCES "public"."recipe_runs"("id") ON DELETE set null ON UPDATE no action,
	"title" text NOT NULL,
	"filename" text NOT NULL,
	"kind" text DEFAULT 'file' NOT NULL,
	"mime_type" text DEFAULT 'text/plain' NOT NULL,
	"content" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"source" text DEFAULT 'assistant' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_artifacts_user_created_idx" ON "workspace_artifacts" USING btree ("user_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_artifacts_thread_idx" ON "workspace_artifacts" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_artifacts_message_idx" ON "workspace_artifacts" USING btree ("chat_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_artifacts_run_idx" ON "workspace_artifacts" USING btree ("recipe_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_artifacts_message_filename_idx" ON "workspace_artifacts" USING btree ("chat_message_id","filename");
