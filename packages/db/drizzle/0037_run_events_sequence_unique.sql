-- #443: replay order integrity for the run_events stream — (run_id, sequence)
-- must be unique so dual writers racing read-max-then-insert fail with a
-- retryable 23505 instead of silently corrupting event order.
--
-- Existing rows may already carry colliding sequences from that race;
-- renumber each run's events in the app's replay order (sequence, occurred_at,
-- id — see apps/web/lib/run-events.ts compareRunEvents) before adding the
-- index so the migration cannot fail on historical data.
WITH renumbered AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "run_id"
			ORDER BY "sequence", "occurred_at", "id"
		) AS new_sequence
	FROM "run_events"
)
UPDATE "run_events"
SET "sequence" = renumbered.new_sequence
FROM renumbered
WHERE "run_events"."id" = renumbered."id"
	AND "run_events"."sequence" <> renumbered.new_sequence;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_events_run_sequence_unique_idx" ON "run_events" USING btree ("run_id","sequence");
