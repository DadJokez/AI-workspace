ALTER TABLE "workspace_artifacts" ADD COLUMN "artifact_group_id" uuid;
--> statement-breakpoint
ALTER TABLE "workspace_artifacts" ADD COLUMN "version_number" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace_artifacts" ADD COLUMN "supersedes_artifact_id" uuid;
--> statement-breakpoint
ALTER TABLE "workspace_artifacts" ADD COLUMN "version_summary" text;
--> statement-breakpoint
UPDATE "workspace_artifacts"
SET "artifact_group_id" = "id"
WHERE "artifact_group_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "workspace_artifacts" ALTER COLUMN "artifact_group_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace_artifacts" ALTER COLUMN "artifact_group_id" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "workspace_artifacts" ADD CONSTRAINT "workspace_artifacts_supersedes_artifact_id_workspace_artifacts_id_fk" FOREIGN KEY ("supersedes_artifact_id") REFERENCES "public"."workspace_artifacts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "workspace_artifacts_group_idx" ON "workspace_artifacts" USING btree ("user_id","artifact_group_id","version_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_artifacts_group_version_idx" ON "workspace_artifacts" USING btree ("user_id","artifact_group_id","version_number");
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid,
	"chat_message_id" uuid,
	"run_id" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"action" jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_chat_message_id_chat_messages_id_fk" FOREIGN KEY ("chat_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "recommendations_user_status_idx" ON "recommendations" USING btree ("user_id","status","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "recommendations_message_idx" ON "recommendations" USING btree ("chat_message_id");
--> statement-breakpoint
CREATE INDEX "recommendations_run_idx" ON "recommendations" USING btree ("run_id");
