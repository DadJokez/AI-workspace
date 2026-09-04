-- #849: least-privilege Postgres role for the Comparative Browser egress proxy.
-- The proxy (apps/web/scripts/browser-egress-proxy.ts) reads exactly one row:
--   SELECT metadata FROM tools_catalog
--   WHERE provider = 'builtin' AND tool_name = '__web_egress_policy__' LIMIT 1
-- so this role gets SELECT on those three columns of that table and nothing
-- else. NOLOGIN on purpose: the role is inert until an operator runs
--   ALTER ROLE "web_egress_policy_reader" LOGIN PASSWORD '<generated>';
-- and stores the resulting URL in the browser-proxy-db secret. No password
-- ever lives in this repo. Requires CREATEROLE on the migrator's role (true for
-- the RDS master user); otherwise run the CREATE ROLE by hand — the GRANTs
-- below are idempotent and safe to replay.
DO $$ BEGIN
 CREATE ROLE "web_egress_policy_reader" NOLOGIN;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO "web_egress_policy_reader"', current_database());
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA "public" TO "web_egress_policy_reader";--> statement-breakpoint
GRANT SELECT ("provider", "tool_name", "metadata") ON "public"."tools_catalog" TO "web_egress_policy_reader";
