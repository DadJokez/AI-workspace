import { closeDb, getDb } from "@ai-workspace/db";
import {
  pruneAuditLog,
  resolveAuditRetentionDays,
} from "@/lib/audit-retention";

async function main() {
  const dryRun = process.env.AUDIT_LOG_RETENTION_DRY_RUN !== "0";
  const retentionDays = resolveAuditRetentionDays();
  const result = await pruneAuditLog({
    db: getDb(),
    retentionDays,
    dryRun,
  });

  console.log(
    JSON.stringify(
      {
        retentionDays: result.retentionDays,
        cutoff: result.cutoff.toISOString(),
        dryRun: result.dryRun,
        matchedRows: result.matchedRows,
        deletedRows: result.deletedRows,
      },
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
