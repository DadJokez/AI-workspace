CREATE TABLE IF NOT EXISTS "app_version_data_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_version_id" uuid NOT NULL,
	"binding_id" text NOT NULL,
	"provider" text NOT NULL,
	"tool_name" text NOT NULL,
	"pinned_args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_version_data_bindings" ADD CONSTRAINT "app_version_data_bindings_app_version_id_app_versions_id_fk" FOREIGN KEY ("app_version_id") REFERENCES "public"."app_versions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_version_data_bindings_version_binding_idx" ON "app_version_data_bindings" USING btree ("app_version_id","binding_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_version_data_bindings_provider_tool_idx" ON "app_version_data_bindings" USING btree ("provider","tool_name");
