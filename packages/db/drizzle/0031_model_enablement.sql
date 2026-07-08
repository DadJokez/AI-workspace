CREATE TABLE IF NOT EXISTS "model_enablement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" text NOT NULL,
	"purpose" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_enablement_model_purpose_idx" ON "model_enablement" USING btree ("model_id","purpose");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_enablement_purpose_idx" ON "model_enablement" USING btree ("purpose","enabled");--> statement-breakpoint
-- Seed: the three Claude tiers stay enabled for every current purpose/lane,
-- preserving exact pre-registry behavior. Any model registered later gets no
-- rows here and is therefore disabled everywhere until qualified (#301).
INSERT INTO "model_enablement" ("model_id", "purpose", "enabled")
SELECT m.model_id, p.purpose, true
FROM (VALUES ('haiku-4-5'), ('sonnet-4-6'), ('opus-4-7')) AS m(model_id)
CROSS JOIN (VALUES
  ('chat'),
  ('fast-local'),
  ('tool-local'),
  ('durable-local'),
  ('summaries'),
  ('routing'),
  ('memory-capture')
) AS p(purpose)
ON CONFLICT ("model_id", "purpose") DO NOTHING;
