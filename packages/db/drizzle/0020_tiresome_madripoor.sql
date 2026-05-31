ALTER TABLE "chat_threads" ADD COLUMN IF NOT EXISTS "preview_summary" text;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN IF NOT EXISTS "preview_summary_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN IF NOT EXISTS "title_source" text DEFAULT 'auto' NOT NULL;
