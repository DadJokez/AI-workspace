import {
  type Database,
  type Notification,
  type Run,
  apps,
  notifications,
  runs,
  shares,
  skills,
  users,
} from "@ai-workspace/db";
import { and, count, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

/**
 * Notification inbox + daily digest (issue #292). Everything here is strictly
 * scoped to the owning user with `eq(userId, ...)` — notifications are
 * personal, so there is deliberately no admin bypass (`userScope()` would
 * grant one).
 */

export type NotificationType = "run_succeeded" | "run_failed";

const DIGEST_FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Write the inbox row for a proactive run that reached a terminal status.
 * Durable chat turns are included because their browser stream closes while
 * the worker continues. Manual skill runs remain live in their thread. The
 * unique index on `run_id` makes this idempotent across worker retries:
 * exactly one notification per run.
 *
 * Never throws — a notification failure must not fail the run. Errors are
 * logged to stderr like the worker's other best-effort side effects.
 */
export async function createProactiveRunNotification(
  db: Database,
  run: Run,
  terminalStatus: "succeeded" | "failed",
  threadId?: string | null,
): Promise<void> {
  const chatRun =
    run.triggerType === "chat" || run.triggerType === "chat_retry";
  if (
    !chatRun &&
    run.triggerType !== "scheduled" &&
    run.triggerType !== "github_event"
  ) {
    return;
  }

  try {
    const skillName = !chatRun && run.skillId
      ? (
          await db
            .select({ name: skills.name })
            .from(skills)
            .where(eq(skills.id, run.skillId))
            .limit(1)
        )[0]?.name
      : undefined;
    const label = chatRun
      ? "Chat"
      : (skillName ?? run.skillSlug ?? "Proactive run");
    const eventTriggered = run.triggerType === "github_event";

    await db
      .insert(notifications)
      .values({
        userId: run.userId,
        type:
          terminalStatus === "succeeded" ? "run_succeeded" : "run_failed",
        title:
          terminalStatus === "succeeded"
            ? `${label} finished`
            : `${label} failed`,
        body:
          terminalStatus === "succeeded"
            ? chatRun
              ? "A background chat run completed while you were away. Open it to see the answer."
              : eventTriggered
                ? "A GitHub event triggered this run while you were away. Open it to see the result."
                : "A scheduled run completed while you were away. Open it to see the result."
            : (run.error ??
              (chatRun
                ? "The background chat run ended with an error."
                : eventTriggered
                  ? "The GitHub event run ended with an error."
                  : "The scheduled run ended with an error.")),
        runId: run.id,
        threadId: threadId ?? run.threadId,
      })
      .onConflictDoNothing({ target: notifications.runId });
  } catch (err) {
    process.stderr.write(
      `[notification-create-error] ${JSON.stringify({
        runId: run.id,
        message: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
  }
}

/** The caller's notifications, newest first, plus their unread count. */
export async function listNotifications(
  db: Database,
  userId: string,
  limit = 50,
): Promise<{ notifications: Notification[]; unreadCount: number }> {
  const [rows, unread] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(limit),
    db
      .select({ value: count() })
      .from(notifications)
      .where(
        and(eq(notifications.userId, userId), isNull(notifications.readAt)),
      ),
  ]);
  return { notifications: rows, unreadCount: unread[0]?.value ?? 0 };
}

/**
 * Mark the caller's notifications read. `ids` limits the sweep; omitting it
 * marks everything. Rows owned by other users are untouchable by
 * construction (the user predicate is always applied).
 */
export async function markNotificationsRead(
  db: Database,
  userId: string,
  ids?: string[],
): Promise<void> {
  if (ids && ids.length === 0) return;
  await db
    .update(notifications)
    .set({ readAt: sql`COALESCE(${notifications.readAt}, now())` })
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        ids ? inArray(notifications.id, ids) : undefined,
      ),
    );
}

/**
 * The user opened this notification's run output — mark it read and record
 * acceptance (the "accepted proactive work" metric; first open wins).
 * Returns the row, or null when it doesn't exist or belongs to someone else.
 */
export async function openNotification(
  db: Database,
  userId: string,
  id: string,
): Promise<Notification | null> {
  const updated = await db
    .update(notifications)
    .set({
      readAt: sql`COALESCE(${notifications.readAt}, now())`,
      acceptedAt: sql`COALESCE(${notifications.acceptedAt}, now())`,
    })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
    .returning();
  return updated[0] ?? null;
}

export interface DigestRun {
  id: string;
  status: string;
  skillName: string | null;
  skillSlug: string | null;
  threadId: string | null;
  error: string | null;
  completedAt: Date | null;
}

export interface DigestShare {
  id: string;
  subjectType: string;
  subjectName: string | null;
  grantedByName: string | null;
  createdAt: Date;
}

export interface Digest {
  since: Date;
  completedRuns: DigestRun[];
  failedRuns: DigestRun[];
  newShares: DigestShare[];
}

/**
 * "Since you were last here" rollup: terminal proactive runs and new active
 * shares since the user's previous digest view. Reading the digest advances
 * `users.digest_viewed_at`, so the next view starts where this one ended.
 * First-ever view falls back to the trailing 24 hours.
 */
export async function buildDigest(
  db: Database,
  userId: string,
  now = new Date(),
): Promise<Digest> {
  const userRow = await db
    .select({ digestViewedAt: users.digestViewedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const since =
    userRow[0]?.digestViewedAt ??
    new Date(now.getTime() - DIGEST_FALLBACK_WINDOW_MS);

  const [digestRuns, digestShares] = await Promise.all([
    db
      .select({
        id: runs.id,
        status: runs.status,
        skillName: skills.name,
        skillSlug: runs.skillSlug,
        threadId: runs.threadId,
        error: runs.error,
        completedAt: runs.completedAt,
      })
      .from(runs)
      .leftJoin(skills, eq(runs.skillId, skills.id))
      .where(
        and(
          eq(runs.userId, userId),
          inArray(runs.triggerType, ["scheduled", "github_event"]),
          inArray(runs.status, ["succeeded", "failed"]),
          gt(runs.completedAt, since),
        ),
      )
      .orderBy(desc(runs.completedAt)),
    db
      .select({
        id: shares.id,
        subjectType: shares.subjectType,
        skillName: skills.name,
        appName: apps.name,
        grantedByName: users.displayName,
        createdAt: shares.createdAt,
      })
      .from(shares)
      .leftJoin(
        skills,
        and(eq(shares.subjectType, "skill"), eq(shares.subjectId, skills.id)),
      )
      .leftJoin(
        apps,
        and(eq(shares.subjectType, "app"), eq(shares.subjectId, apps.id)),
      )
      .leftJoin(users, eq(shares.grantedByUserId, users.id))
      .where(
        and(
          eq(shares.grantedToUserId, userId),
          isNull(shares.revokedAt),
          gt(shares.createdAt, since),
        ),
      )
      .orderBy(desc(shares.createdAt)),
  ]);

  await db
    .update(users)
    .set({ digestViewedAt: now })
    .where(eq(users.id, userId));

  return {
    since,
    completedRuns: digestRuns.filter((r) => r.status === "succeeded"),
    failedRuns: digestRuns.filter((r) => r.status === "failed"),
    newShares: digestShares.map((s) => ({
      id: s.id,
      subjectType: s.subjectType,
      subjectName: s.subjectType === "app" ? s.appName : s.skillName,
      grantedByName: s.grantedByName,
      createdAt: s.createdAt,
    })),
  };
}
