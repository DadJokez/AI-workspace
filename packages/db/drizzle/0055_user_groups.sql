-- Group memberships asserted by the identity provider at OIDC sign-in
-- (AUTH_PROVIDERS=pingone). A user's rows are replaced in one transaction on
-- every sign-in, so the table always reflects the last groups claim seen.
-- Nothing authorizes from it yet: access and the admin role are decided from
-- the claim itself at sign-in; these rows are what an admin reads back.
-- Additive: the deployed code never touches the table.
CREATE TABLE IF NOT EXISTS "user_groups" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "group_name" text NOT NULL,
  "source" text NOT NULL DEFAULT 'oidc',
  "synced_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "user_groups_user_id_group_name_pk" PRIMARY KEY ("user_id", "group_name")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_groups_group_name_idx" ON "user_groups" ("group_name");
--> statement-breakpoint
-- The sign-in gate and the adapter look users up by lower(email) on every
-- sign-in; until now that was a sequential scan.
CREATE INDEX IF NOT EXISTS "users_email_lower_idx" ON "users" (lower("email"));
