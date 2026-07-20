CREATE INDEX IF NOT EXISTS "memory_capture_queue_from_message_idx" ON "memory_capture_queue" USING btree ("from_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_capture_queue_to_message_idx" ON "memory_capture_queue" USING btree ("to_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_capture_queue_status_created_idx" ON "memory_capture_queue" USING btree ("status","created_at");
