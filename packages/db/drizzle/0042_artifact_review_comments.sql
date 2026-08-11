CREATE TYPE "artifact_review_comment_status" AS ENUM ('open', 'addressing', 'addressed');

CREATE TABLE "artifact_review_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid,
	"artifact_owner_user_id" uuid NOT NULL,
	"artifact_group_id" uuid NOT NULL,
	"artifact_version_number" integer NOT NULL,
	"artifact_filename" text NOT NULL,
	"thread_id" uuid,
	"author_user_id" uuid,
	"author_display_name" text NOT NULL,
	"body" text NOT NULL,
	"anchor" jsonb NOT NULL,
	"status" "artifact_review_comment_status" DEFAULT 'open' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"addressing_run_id" uuid,
	"addressed_by_user_id" uuid,
	"addressed_at" timestamp with time zone,
	"result_artifact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "artifact_review_comments" ADD CONSTRAINT "artifact_review_comments_artifact_id_workspace_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."workspace_artifacts"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "artifact_review_comments" ADD CONSTRAINT "artifact_review_comments_artifact_owner_user_id_users_id_fk" FOREIGN KEY ("artifact_owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "artifact_review_comments" ADD CONSTRAINT "artifact_review_comments_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "artifact_review_comments" ADD CONSTRAINT "artifact_review_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "artifact_review_comments" ADD CONSTRAINT "artifact_review_comments_addressing_run_id_runs_id_fk" FOREIGN KEY ("addressing_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "artifact_review_comments" ADD CONSTRAINT "artifact_review_comments_addressed_by_user_id_users_id_fk" FOREIGN KEY ("addressed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "artifact_review_comments" ADD CONSTRAINT "artifact_review_comments_result_artifact_id_workspace_artifacts_id_fk" FOREIGN KEY ("result_artifact_id") REFERENCES "public"."workspace_artifacts"("id") ON DELETE set null ON UPDATE no action;

CREATE INDEX "artifact_review_comments_artifact_status_created_idx" ON "artifact_review_comments" USING btree ("artifact_id", "status", "created_at");
CREATE INDEX "artifact_review_comments_version_created_idx" ON "artifact_review_comments" USING btree ("artifact_owner_user_id", "artifact_group_id", "artifact_version_number", "created_at");
CREATE INDEX "artifact_review_comments_author_created_idx" ON "artifact_review_comments" USING btree ("author_user_id", "created_at");
CREATE INDEX "artifact_review_comments_addressing_run_idx" ON "artifact_review_comments" USING btree ("addressing_run_id");
CREATE INDEX "artifact_review_comments_result_artifact_idx" ON "artifact_review_comments" USING btree ("result_artifact_id");
