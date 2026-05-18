CREATE TABLE IF NOT EXISTS "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'info' NOT NULL,
	"label" text NOT NULL,
	"provider" text,
	"tool_name" text,
	"tool_call_id" text,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_events" ADD CONSTRAINT "run_events_recipe_run_id_recipe_runs_id_fk" FOREIGN KEY ("recipe_run_id") REFERENCES "public"."recipe_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_events_run_idx" ON "run_events" USING btree ("recipe_run_id","sequence","occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_events_type_idx" ON "run_events" USING btree ("event_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_events_tool_call_idx" ON "run_events" USING btree ("tool_call_id");
