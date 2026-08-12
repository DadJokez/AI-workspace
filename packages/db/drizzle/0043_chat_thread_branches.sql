CREATE TYPE "public"."chat_thread_branch_source_type" AS ENUM('message', 'thread', 'artifact', 'app_version', 'proposal');
--> statement-breakpoint
CREATE TABLE "chat_thread_branches" (
	"thread_id" uuid PRIMARY KEY NOT NULL,
	"parent_thread_id" uuid,
	"parent_thread_id_snapshot" uuid,
	"branch_point_message_id" uuid,
	"branch_point_message_id_snapshot" uuid,
	"source_type" "chat_thread_branch_source_type" NOT NULL,
	"source_artifact_id" uuid,
	"source_artifact_id_snapshot" uuid,
	"source_app_version_id" uuid,
	"source_app_version_id_snapshot" uuid,
	"created_by_user_id" uuid,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_thread_branches_not_self" CHECK ("parent_thread_id" IS NULL OR "parent_thread_id" <> "thread_id"),
	CONSTRAINT "chat_thread_branches_parent_snapshot" CHECK ("parent_thread_id" IS NULL OR "parent_thread_id_snapshot" IS NOT NULL),
	CONSTRAINT "chat_thread_branches_message_snapshot" CHECK ("source_type" NOT IN ('message', 'thread') OR "branch_point_message_id_snapshot" IS NOT NULL),
	CONSTRAINT "chat_thread_branches_artifact_snapshot" CHECK ("source_type" NOT IN ('artifact', 'app_version', 'proposal') OR "source_artifact_id_snapshot" IS NOT NULL),
	CONSTRAINT "chat_thread_branches_app_version_snapshot" CHECK ("source_type" <> 'app_version' OR "source_app_version_id_snapshot" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "chat_thread_branches" ADD CONSTRAINT "chat_thread_branches_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_thread_branches" ADD CONSTRAINT "chat_thread_branches_parent_thread_id_chat_threads_id_fk" FOREIGN KEY ("parent_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_thread_branches" ADD CONSTRAINT "chat_thread_branches_branch_point_message_id_chat_messages_id_fk" FOREIGN KEY ("branch_point_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_thread_branches" ADD CONSTRAINT "chat_thread_branches_source_artifact_id_workspace_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."workspace_artifacts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_thread_branches" ADD CONSTRAINT "chat_thread_branches_source_app_version_id_app_versions_id_fk" FOREIGN KEY ("source_app_version_id") REFERENCES "public"."app_versions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_thread_branches" ADD CONSTRAINT "chat_thread_branches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "chat_thread_branches_parent_idx" ON "chat_thread_branches" USING btree ("parent_thread_id", "created_at");
--> statement-breakpoint
CREATE INDEX "chat_thread_branches_point_idx" ON "chat_thread_branches" USING btree ("branch_point_message_id");
--> statement-breakpoint
CREATE INDEX "chat_thread_branches_artifact_idx" ON "chat_thread_branches" USING btree ("source_artifact_id");
--> statement-breakpoint
CREATE INDEX "chat_thread_branches_app_version_idx" ON "chat_thread_branches" USING btree ("source_app_version_id");
--> statement-breakpoint
CREATE INDEX "chat_thread_branches_actor_idx" ON "chat_thread_branches" USING btree ("created_by_user_id", "created_at");
