-- Provider-specific connection metadata (e.g. Salesforce per-user instance_url).
-- Nullable; providers that need no metadata leave it NULL.
ALTER TABLE "oauth_tokens" ADD COLUMN IF NOT EXISTS "provider_metadata" jsonb;
