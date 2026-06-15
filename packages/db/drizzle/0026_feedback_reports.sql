CREATE TABLE "feedback_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid,
	"chat_message_id" uuid,
	"run_id" uuid,
	"artifact_id" uuid,
	"report_type" text DEFAULT 'bug' NOT NULL,
	"severity" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"expected" text,
	"page_url" text,
	"user_agent" text,
	"viewport" jsonb,
	"context" jsonb,
	"screenshot_data_url" text,
	"screenshot_name" text,
	"screenshot_mime_type" text,
	"linked_issue_url" text,
	"admin_notes" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback_reports" ADD CONSTRAINT "feedback_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "feedback_reports" ADD CONSTRAINT "feedback_reports_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "feedback_reports" ADD CONSTRAINT "feedback_reports_chat_message_id_chat_messages_id_fk" FOREIGN KEY ("chat_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "feedback_reports" ADD CONSTRAINT "feedback_reports_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "feedback_reports" ADD CONSTRAINT "feedback_reports_artifact_id_workspace_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."workspace_artifacts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "feedback_reports_status_created_idx" ON "feedback_reports" USING btree ("status","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "feedback_reports_user_created_idx" ON "feedback_reports" USING btree ("user_id","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "feedback_reports_thread_idx" ON "feedback_reports" USING btree ("thread_id");
