import { auditLog, type Database } from "@ai-workspace/db";
import { count, lt } from "drizzle-orm";

export const DEFAULT_AUDIT_LOG_RETENTION_DAYS = 365;
export const MIN_AUDIT_LOG_RETENTION_DAYS = 30;
export const MAX_AUDIT_LOG_RETENTION_DAYS = 3650;

export interface AuditRetentionResult {
  cutoff: Date;
  retentionDays: number;
  dryRun: boolean;
  matchedRows: number;
  deletedRows: number;
}

export function resolveAuditRetentionDays(
  raw = process.env.AUDIT_LOG_RETENTION_DAYS,
): number {
  if (!raw) return DEFAULT_AUDIT_LOG_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AUDIT_LOG_RETENTION_DAYS;
  }
  const wholeDays = Math.floor(parsed);
  return Math.min(
    MAX_AUDIT_LOG_RETENTION_DAYS,
    Math.max(MIN_AUDIT_LOG_RETENTION_DAYS, wholeDays),
  );
}

export function assertDestructiveAuditRetentionConfigured({
  dryRun,
  raw = process.env.AUDIT_LOG_RETENTION_DAYS,
}: {
  dryRun: boolean;
  raw?: string;
}): void {
  if (dryRun) return;
  const value = raw?.trim();
  const parsed = value ? Number(value) : Number.NaN;
  if (!value || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      "Set AUDIT_LOG_RETENTION_DAYS to a positive number of days before running destructive audit retention cleanup.",
    );
  }
}

export function auditRetentionCutoff(
  now = new Date(),
  retentionDays = resolveAuditRetentionDays(),
): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

export async function pruneAuditLog({
  db,
  now = new Date(),
  retentionDays = resolveAuditRetentionDays(),
  dryRun = false,
}: {
  db: Database;
  now?: Date;
  retentionDays?: number;
  dryRun?: boolean;
}): Promise<AuditRetentionResult> {
  const cutoff = auditRetentionCutoff(now, retentionDays);
  if (dryRun) {
    const rows = await db
      .select({ value: count(auditLog.id) })
      .from(auditLog)
      .where(lt(auditLog.createdAt, cutoff));
    const matchedRows = rows[0]?.value ?? 0;
    return {
      cutoff,
      retentionDays,
      dryRun,
      matchedRows,
      deletedRows: 0,
    };
  }

  const deleted = await db
    .delete(auditLog)
    .where(lt(auditLog.createdAt, cutoff))
    .returning({ id: auditLog.id });

  return {
    cutoff,
    retentionDays,
    dryRun,
    matchedRows: deleted.length,
    deletedRows: deleted.length,
  };
}
