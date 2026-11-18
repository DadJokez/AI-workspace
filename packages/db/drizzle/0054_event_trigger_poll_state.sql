-- Poll mode for GitHub event triggers (GITHUB_EVENT_INGEST_MODE=poll): the chat
-- worker reads each repository's events feed instead of receiving webhooks.
-- poll_state holds the feed cursor per trigger (ETag, first-poll floor, events
-- already handled); poll_next_at and the claim pair lease a repository to one
-- worker at a time, as schedules.claimed_at / claimed_by do. All four stay NULL
-- in webhook mode. Additive and nullable: the deployed code ignores them.
ALTER TABLE "event_triggers" ADD COLUMN IF NOT EXISTS "poll_state" jsonb;
--> statement-breakpoint
ALTER TABLE "event_triggers" ADD COLUMN IF NOT EXISTS "poll_next_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "event_triggers" ADD COLUMN IF NOT EXISTS "poll_claimed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "event_triggers" ADD COLUMN IF NOT EXISTS "poll_claimed_by" text;
