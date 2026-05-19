ALTER TABLE "recipe_runs"
  ADD COLUMN IF NOT EXISTS "worker_id" text,
  ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "attempt_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "recipe_runs_worker_claim_idx"
  ON "recipe_runs" ("status", "lease_expires_at", "created_at");
