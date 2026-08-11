CREATE TABLE "studio_browser_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"run_id" uuid,
	"provider_session_id" text NOT NULL,
	"browser_identifier" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_resource_id" text,
	"display_url" text NOT NULL,
	"origin" text NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"viewport_width" integer DEFAULT 1440 NOT NULL,
	"viewport_height" integer DEFAULT 900 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"last_error" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_browser_sessions_status_check" CHECK ("status" IN ('starting', 'ready', 'stopping', 'stopped', 'expired', 'failed')),
	CONSTRAINT "studio_browser_sessions_target_kind_check" CHECK ("target_kind" IN ('public', 'artifact', 'app', 'sandbox')),
	CONSTRAINT "studio_browser_sessions_viewport_check" CHECK ("viewport_width" BETWEEN 800 AND 2560 AND "viewport_height" BETWEEN 600 AND 1440)
);
--> statement-breakpoint
CREATE TABLE "studio_browser_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"browser_session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"run_id" uuid,
	"target_kind" text NOT NULL,
	"target_resource_id" text NOT NULL,
	"target_path" text NOT NULL,
	"sandbox_port" integer,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_browser_grants_target_kind_check" CHECK ("target_kind" IN ('artifact', 'app', 'sandbox')),
	CONSTRAINT "studio_browser_grants_sandbox_port_check" CHECK ("sandbox_port" IS NULL OR "sandbox_port" BETWEEN 1024 AND 65535)
);
--> statement-breakpoint
CREATE TABLE "studio_sandbox_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"run_id" uuid,
	"hostname" text NOT NULL,
	"allowed_ports" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_sandbox_endpoints_status_check" CHECK ("status" IN ('active', 'stopped', 'expired')),
	CONSTRAINT "studio_sandbox_endpoints_hostname_check" CHECK ("hostname" ~ '^[a-zA-Z0-9.-]{1,253}$')
);
--> statement-breakpoint
ALTER TABLE "studio_browser_sessions" ADD CONSTRAINT "studio_browser_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "studio_browser_sessions" ADD CONSTRAINT "studio_browser_sessions_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "studio_browser_sessions" ADD CONSTRAINT "studio_browser_sessions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "studio_browser_grants" ADD CONSTRAINT "studio_browser_grants_browser_session_id_studio_browser_sessions_id_fk" FOREIGN KEY ("browser_session_id") REFERENCES "public"."studio_browser_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "studio_browser_grants" ADD CONSTRAINT "studio_browser_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "studio_browser_grants" ADD CONSTRAINT "studio_browser_grants_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "studio_browser_grants" ADD CONSTRAINT "studio_browser_grants_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "studio_sandbox_endpoints" ADD CONSTRAINT "studio_sandbox_endpoints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "studio_sandbox_endpoints" ADD CONSTRAINT "studio_sandbox_endpoints_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "studio_sandbox_endpoints" ADD CONSTRAINT "studio_sandbox_endpoints_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "studio_browser_sessions_provider_session_idx" ON "studio_browser_sessions" USING btree ("provider_session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "studio_browser_sessions_active_user_thread_idx" ON "studio_browser_sessions" USING btree ("user_id","thread_id") WHERE "studio_browser_sessions"."status" IN ('starting', 'ready');
--> statement-breakpoint
CREATE INDEX "studio_browser_sessions_user_created_idx" ON "studio_browser_sessions" USING btree ("user_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "studio_browser_sessions_thread_created_idx" ON "studio_browser_sessions" USING btree ("thread_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "studio_browser_sessions_status_expiry_idx" ON "studio_browser_sessions" USING btree ("status","expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "studio_browser_grants_token_hash_idx" ON "studio_browser_grants" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "studio_browser_grants_session_idx" ON "studio_browser_grants" USING btree ("browser_session_id","expires_at");
--> statement-breakpoint
CREATE INDEX "studio_browser_grants_user_thread_idx" ON "studio_browser_grants" USING btree ("user_id","thread_id");
--> statement-breakpoint
CREATE INDEX "studio_sandbox_endpoints_user_thread_idx" ON "studio_sandbox_endpoints" USING btree ("user_id","thread_id","status");
--> statement-breakpoint
CREATE INDEX "studio_sandbox_endpoints_expiry_idx" ON "studio_sandbox_endpoints" USING btree ("expires_at");
