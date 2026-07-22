import { getDb } from "@ai-workspace/db";
import { backfillMissingMemoryCaptures } from "../lib/memory-capture";

const args = parseArgs(process.argv.slice(2));

backfillMissingMemoryCaptures(getDb(), args)
  .then((result) => {
    process.stdout.write(
      `[memory-capture-backfill-result] ${JSON.stringify({
        since: args.since.toISOString(),
        until: args.until.toISOString(),
        ...result,
      })}\n`,
    );
  })
  .catch((err) => {
    process.stderr.write(
      `[memory-capture-backfill-error] ${JSON.stringify({
        message: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
    process.exitCode = 1;
  });

function parseArgs(argv: string[]): {
  since: Date;
  until: Date;
  limit?: number;
} {
  const since = dateArg(argv, "--since");
  const until = dateArg(argv, "--until");
  const rawLimit = valueArg(argv, "--limit");
  const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer.");
  }
  return { since, until, ...(limit ? { limit } : {}) };
}

function dateArg(argv: string[], name: string): Date {
  const raw = valueArg(argv, name);
  if (!raw) {
    throw new Error(
      `Missing ${name}. Provide an explicit ISO outage boundary to avoid reprocessing old turns.`,
    );
  }
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw new Error(`${name} must be a valid ISO date.`);
  }
  return value;
}

function valueArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}
