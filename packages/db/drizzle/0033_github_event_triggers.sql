CREATE TABLE IF NOT EXISTS "event_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"source" text DEFAULT 'github' NOT NULL,
	"repository" text NOT NULL,
	"event_type" text NOT NULL,
	"action" text,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"thread_mode" text DEFAULT 'dedicated' NOT NULL,
	"target_thread_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_triggers" ADD CONSTRAINT "event_triggers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_triggers" ADD CONSTRAINT "event_triggers_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_triggers" ADD CONSTRAINT "event_triggers_target_thread_id_chat_threads_id_fk" FOREIGN KEY ("target_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_triggers_lookup_idx" ON "event_triggers" USING btree ("source","repository","event_type","enabled","deleted_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_triggers_user_idx" ON "event_triggers" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_triggers_skill_idx" ON "event_triggers" USING btree ("skill_id");
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "event_trigger_id" uuid;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "event_delivery_id" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_event_trigger_id_event_triggers_id_fk" FOREIGN KEY ("event_trigger_id") REFERENCES "public"."event_triggers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_event_trigger_idx" ON "runs" USING btree ("event_trigger_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runs_event_delivery_idx" ON "runs" USING btree ("event_trigger_id","event_delivery_id") WHERE "event_trigger_id" IS NOT NULL AND "event_delivery_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_trigger_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger_id" uuid NOT NULL,
	"run_id" uuid,
	"source" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_action" text,
	"repository" text NOT NULL,
	"event_summary" text NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_trigger_deliveries" ADD CONSTRAINT "event_trigger_deliveries_trigger_id_event_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."event_triggers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_trigger_deliveries" ADD CONSTRAINT "event_trigger_deliveries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_trigger_deliveries_trigger_delivery_idx" ON "event_trigger_deliveries" USING btree ("trigger_id","delivery_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_trigger_deliveries_run_idx" ON "event_trigger_deliveries" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_trigger_deliveries_received_idx" ON "event_trigger_deliveries" USING btree ("received_at");
