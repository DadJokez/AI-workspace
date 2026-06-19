ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "revoked_by" uuid;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "email_status" text DEFAULT 'not_sent' NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "email_send_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "last_email_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "last_email_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "last_email_error" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "last_email_message_id" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invitations" ADD CONSTRAINT "invitations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_revoked_idx" ON "invitations" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_email_status_idx" ON "invitations" USING btree ("email_status");
