ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS summary text;
--> statement-breakpoint
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS summary_updated_at timestamp with time zone;
