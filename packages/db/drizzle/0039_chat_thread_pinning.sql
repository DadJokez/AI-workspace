ALTER TABLE "chat_threads" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;

CREATE INDEX "chat_threads_user_pinned_updated_idx"
	ON "chat_threads" USING btree ("user_id", "pinned" DESC, "updated_at" DESC);
