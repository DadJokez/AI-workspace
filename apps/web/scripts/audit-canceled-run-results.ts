import { closeDb, getDb, runs } from "@ai-workspace/db";
import { and, count, eq, sql } from "drizzle-orm";

/**
 * #655 evidence probe (read-only): counts legacy runs that the pre-fix race
 * marked canceled after their durable assistant answer had already committed.
 * A non-zero count is the signal that read-side containment for those legacy
 * rows is worth building; zero means it never fired in this environment.
 */
async function main() {
  const db = getDb();
  const rows = await db
    .select({ value: count() })
    .from(runs)
    .where(
      and(
        eq(runs.status, "canceled"),
        sql`${runs.outputs} ->> 'assistantMessageId' is not null`,
      ),
    );

  console.log(
    JSON.stringify(
      { canceledRunsWithCommittedResult: rows[0]?.value ?? 0 },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
