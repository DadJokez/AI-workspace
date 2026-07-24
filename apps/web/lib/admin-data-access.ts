import type { SessionUser } from "@ai-workspace/auth";
import { auditLog, type Database } from "@ai-workspace/db";
import { and, eq, gte, sql } from "drizzle-orm";

export const ADMIN_DATA_ACCESS_ACTION = "admin_data_access";
export const ADMIN_DATA_ACCESS_SCHEMA = "admin-data-access.v1";
export const ADMIN_DATA_ACCESS_JUSTIFICATION_HEADER =
  "x-admin-access-justification";

const ACCESS_DEDUPE_WINDOW_MS = 5 * 60 * 1_000;
const MAX_RECENT_ACCESS_ROWS = 5_000;
const UNKNOWN_TARGET_USER_ID = "unknown";

export interface AdminDataAccess {
  targetUserId: string | null;
  resourceType: string;
  resourceId: string;
  surface: string;
  justification?: string | null;
  resourceCount?: number;
  chatThreadId?: string | null;
  runId?: string | null;
}

export interface AdminDataAccessMetadata {
  schema: typeof ADMIN_DATA_ACCESS_SCHEMA;
  targetUserId: string;
  resourceType: string;
  resourceId: string;
  surface: string;
  justification?: string;
  resourceCount?: number;
}

interface NormalizedAdminDataAccess extends AdminDataAccess {
  targetUserId: string;
  resourceType: string;
  resourceId: string;
  surface: string;
  justification: string | null;
  resourceCount?: number;
}

export interface AdminDataAccessAuditResult {
  inserted: number;
  deduplicated: number;
  skipped: number;
}

/**
 * Record one cross-user admin read. Cross-user admin reads fail closed if the
 * append-only ledger is unavailable; owner reads and non-admin reads do not
 * create admin-access noise.
 */
export async function auditAdminDataAccess({
  db,
  actor,
  access,
  now,
}: {
  db: Database;
  actor: Pick<SessionUser, "id" | "role">;
  access: AdminDataAccess;
  now?: Date;
}): Promise<"audited" | "deduplicated" | "skipped"> {
  const result = await auditAdminDataAccessBatch({
    db,
    actor,
    accesses: [access],
    now,
  });
  if (result.inserted > 0) return "audited";
  if (result.deduplicated > 0) return "deduplicated";
  return "skipped";
}

/**
 * Batch variant for admin collection pages. Repeated resources for the same
 * target user are collapsed into one event with a resource count, avoiding an
 * audit-write storm while retaining who accessed whose records.
 */
export async function auditAdminDataAccessBatch({
  db,
  actor,
  accesses,
  now = new Date(),
}: {
  db: Database;
  actor: Pick<SessionUser, "id" | "role">;
  accesses: AdminDataAccess[];
  now?: Date;
}): Promise<AdminDataAccessAuditResult> {
  if (actor.role !== "admin") {
    return { inserted: 0, deduplicated: 0, skipped: accesses.length };
  }

  const normalized = new Map<string, NormalizedAdminDataAccess>();
  let skipped = 0;
  for (const access of accesses) {
    const next = normalizeAccess(access, actor.id);
    if (!next) {
      skipped += 1;
      continue;
    }
    const key = accessKey(next);
    const existing = normalized.get(key);
    if (existing) {
      if (next.resourceCount !== undefined) {
        existing.resourceCount =
          (existing.resourceCount ?? 0) + next.resourceCount;
      }
      continue;
    }
    normalized.set(key, next);
  }

  if (normalized.size === 0) {
    return { inserted: 0, deduplicated: 0, skipped };
  }

  const candidates = [...normalized.values()];
  const windowStart = new Date(now.getTime() - ACCESS_DEDUPE_WINDOW_MS);
  const only = candidates.length === 1 ? candidates[0] : null;
  const recent = await db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorUserId, actor.id),
        eq(auditLog.actionType, ADMIN_DATA_ACCESS_ACTION),
        gte(auditLog.createdAt, windowStart),
        ...(only
          ? [
              sql`${auditLog.metadata} ->> 'targetUserId' = ${only.targetUserId}`,
              sql`${auditLog.metadata} ->> 'resourceType' = ${only.resourceType}`,
              sql`${auditLog.metadata} ->> 'resourceId' = ${only.resourceId}`,
              sql`${auditLog.metadata} ->> 'surface' = ${only.surface}`,
            ]
          : []),
      ),
    )
    .limit(only ? 1 : MAX_RECENT_ACCESS_ROWS);
  const recentKeys = new Set(
    recent
      .map((row) => parseAdminDataAccessMetadata(row.metadata))
      .filter((metadata) => metadata !== null)
      .map(accessKey),
  );

  const pending = candidates.filter(
    (access) => !recentKeys.has(accessKey(access)),
  );
  if (pending.length > 0) {
    await db.insert(auditLog).values(
      pending.map((access) => ({
        actorUserId: actor.id,
        actionType: ADMIN_DATA_ACCESS_ACTION,
        status: "succeeded" as const,
        provider: "ai-hub",
        chatThreadId: access.chatThreadId ?? null,
        runId: access.runId ?? null,
        metadata: toMetadata(access),
        startedAt: now,
        completedAt: now,
        createdAt: now,
      })),
    );
  }

  return {
    inserted: pending.length,
    deduplicated: normalized.size - pending.length,
    skipped,
  };
}

export function adminDataAccessJustification(
  request: Request,
): string | null {
  return cleanText(
    request.headers.get(ADMIN_DATA_ACCESS_JUSTIFICATION_HEADER),
    500,
  );
}

export function parseAdminDataAccessMetadata(
  value: unknown,
): AdminDataAccessMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (
    metadata.schema !== ADMIN_DATA_ACCESS_SCHEMA ||
    typeof metadata.targetUserId !== "string" ||
    typeof metadata.resourceType !== "string" ||
    typeof metadata.resourceId !== "string" ||
    typeof metadata.surface !== "string"
  ) {
    return null;
  }

  const justification =
    typeof metadata.justification === "string"
      ? cleanText(metadata.justification, 500)
      : null;
  const resourceCount =
    typeof metadata.resourceCount === "number" &&
    Number.isInteger(metadata.resourceCount) &&
    metadata.resourceCount > 0
      ? metadata.resourceCount
      : undefined;

  return {
    schema: ADMIN_DATA_ACCESS_SCHEMA,
    targetUserId: metadata.targetUserId,
    resourceType: metadata.resourceType,
    resourceId: metadata.resourceId,
    surface: metadata.surface,
    ...(justification ? { justification } : {}),
    ...(resourceCount !== undefined ? { resourceCount } : {}),
  };
}

function normalizeAccess(
  access: AdminDataAccess,
  actorUserId: string,
): NormalizedAdminDataAccess | null {
  const targetUserId =
    cleanText(access.targetUserId, 200) ?? UNKNOWN_TARGET_USER_ID;
  const resourceType = cleanText(access.resourceType, 100);
  const resourceId = cleanText(access.resourceId, 200);
  const surface = cleanText(access.surface, 100);
  if (
    targetUserId === actorUserId ||
    !resourceType ||
    !resourceId ||
    !surface
  ) {
    return null;
  }

  const resourceCount =
    typeof access.resourceCount === "number" &&
    Number.isFinite(access.resourceCount) &&
    access.resourceCount > 0
      ? Math.min(10_000, Math.floor(access.resourceCount))
      : undefined;

  return {
    ...access,
    targetUserId,
    resourceType,
    resourceId,
    surface,
    justification: cleanText(access.justification, 500),
    ...(resourceCount !== undefined ? { resourceCount } : {}),
  };
}

function toMetadata(
  access: NormalizedAdminDataAccess,
): AdminDataAccessMetadata {
  return {
    schema: ADMIN_DATA_ACCESS_SCHEMA,
    targetUserId: access.targetUserId,
    resourceType: access.resourceType,
    resourceId: access.resourceId,
    surface: access.surface,
    ...(access.justification
      ? { justification: access.justification }
      : {}),
    ...(access.resourceCount !== undefined
      ? { resourceCount: access.resourceCount }
      : {}),
  };
}

function accessKey(
  access: Pick<
    AdminDataAccessMetadata,
    "targetUserId" | "resourceType" | "resourceId" | "surface"
  >,
): string {
  return [
    access.targetUserId,
    access.resourceType,
    access.resourceId,
    access.surface,
  ].join("\u0000");
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}
