import type { SessionUser } from "@ai-workspace/auth";
import {
  auditLog,
  eventTriggers,
  getDb,
  oauthTokens,
  runs,
  schedules,
  users,
  type Database,
  type UserStatus,
} from "@ai-workspace/db";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { parseAdminReason } from "@/lib/admin-reason";
import { revokeOAuthConnection } from "@/lib/oauth/connection";
import { cancelRun } from "@/lib/run-actions";

/**
 * User lifecycle: suspend, deprovision, reactivate. Nothing is ever deleted.
 *
 * Suspend and deprovision run as ONE transaction that
 *   1. sets `users.status`, `status_changed_at` and `status_reason`, and bumps
 *      `session_version`, so every JWT issued so far is refused by
 *      `getSessionUser` from the next request on;
 *   2. revokes the user's delegated OAuth connections through the existing
 *      `oauth_tokens.revoked_at` path (`revokeOAuthConnection`: token
 *      scrubbed, grants revoked, `connection.revoked` audit rows). Revocation
 *      at the provider is not attempted here (#692);
 *   3. turns off the user's schedules and event triggers (their `enabled`
 *      flags);
 *   4. cancels the user's queued, running and waiting runs through the
 *      existing cancel path (`cancelRun`: `run_canceled` event, `run_cancel`
 *      audit row; a running run is aborted by its worker on its next poll);
 *   5. writes a `user.suspended` / `user.deprovisioned` audit row naming the
 *      actor, the reason and every effect.
 *
 * Reactivate restores sign-in only: the status returns to `active`, and the
 * schedules, triggers and connections stay off until the user turns them back
 * on. It does not bump `session_version`; tokens from before the suspension
 * already failed to match and still do.
 *
 * Guards: an admin cannot suspend or deprovision themself, and nobody can
 * suspend or deprovision the last active admin (the active admins are locked
 * first, so two admins suspending each other at once cannot both succeed).
 *
 * The chat worker and the scheduler also refuse work for a user who is not
 * active (`chat-run-worker.ts` claim, `schedules/scheduler.ts` claim), so a
 * run enqueued concurrently with a suspension is never executed.
 */

export type LifecycleAction = "suspend" | "deprovision" | "reactivate";

export type LifecycleError =
  | "invalid_reason"
  | "user_not_found"
  | "cannot_change_self"
  | "last_admin"
  | "invalid_transition";

export const LIFECYCLE_ERROR_MESSAGES: Record<LifecycleError, string> = {
  invalid_reason: "Give a reason of 1 to 500 characters.",
  user_not_found: "That user no longer exists.",
  cannot_change_self: "You can't suspend or deprovision your own account.",
  last_admin:
    "This is the last active admin. Make someone else an admin first.",
  invalid_transition: "The account is no longer in a state that allows this.",
};

export interface LifecycleEffects {
  sessionVersion: number;
  /** Providers whose connection was revoked. */
  revokedConnections: string[];
  disabledScheduleIds: string[];
  disabledEventTriggerIds: string[];
  canceledRunIds: string[];
  /** Active runs the cancel path could not cancel (not a worker run type). */
  uncanceledRunIds: string[];
}

export type LifecycleResult =
  | {
      ok: true;
      user: {
        id: string;
        status: UserStatus;
        statusChangedAt: Date;
        statusReason: string;
      };
      effects: LifecycleEffects;
    }
  | { ok: false; status: 400 | 404 | 409; error: LifecycleError };

export interface LifecycleOptions {
  db?: Database;
  /** The clock; tests pass a fixed instant. */
  now?: Date;
}

/** Which statuses each action may start from, and where it leaves the user. */
export const LIFECYCLE_TRANSITIONS: Record<
  LifecycleAction,
  { from: readonly UserStatus[]; to: UserStatus }
> = {
  suspend: { from: ["active"], to: "suspended" },
  deprovision: { from: ["active", "suspended"], to: "deprovisioned" },
  reactivate: { from: ["suspended", "deprovisioned"], to: "active" },
};

export const LIFECYCLE_AUDIT_ACTIONS: Record<LifecycleAction, string> = {
  suspend: "user.suspended",
  deprovision: "user.deprovisioned",
  reactivate: "user.reactivated",
};

const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting_for_approval"] as const;

export function suspendUser(
  userId: string,
  actor: SessionUser,
  reason: unknown,
  options: LifecycleOptions = {},
): Promise<LifecycleResult> {
  return changeUserStatus("suspend", userId, actor, reason, options);
}

export function deprovisionUser(
  userId: string,
  actor: SessionUser,
  reason: unknown,
  options: LifecycleOptions = {},
): Promise<LifecycleResult> {
  return changeUserStatus("deprovision", userId, actor, reason, options);
}

export function reactivateUser(
  userId: string,
  actor: SessionUser,
  reason: unknown,
  options: LifecycleOptions = {},
): Promise<LifecycleResult> {
  return changeUserStatus("reactivate", userId, actor, reason, options);
}

async function changeUserStatus(
  action: LifecycleAction,
  userId: string,
  actor: SessionUser,
  rawReason: unknown,
  { db = getDb(), now = new Date() }: LifecycleOptions,
): Promise<LifecycleResult> {
  const reason = parseAdminReason(rawReason);
  if (!reason) return refuse(400, "invalid_reason");
  const transition = LIFECYCLE_TRANSITIONS[action];
  const deactivating = transition.to !== "active";
  if (deactivating && userId === actor.id) {
    return refuse(400, "cannot_change_self");
  }

  return db.transaction(async (tx): Promise<LifecycleResult> => {
    const txDb = tx as unknown as Database;
    const target = (
      await tx
        .select({ id: users.id, role: users.role, status: users.status })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update")
    )[0];
    if (!target) return refuse(404, "user_not_found");
    if (!transition.from.includes(target.status)) {
      return refuse(409, "invalid_transition");
    }
    if (deactivating && target.role === "admin" && target.status === "active") {
      const otherActiveAdmins = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.role, "admin"),
            eq(users.status, "active"),
            ne(users.id, userId),
          ),
        )
        .for("update");
      if (otherActiveAdmins.length === 0) return refuse(409, "last_admin");
    }

    const updated = (
      await tx
        .update(users)
        .set({
          status: transition.to,
          statusChangedAt: now,
          statusReason: reason,
          ...(deactivating
            ? { sessionVersion: sql`${users.sessionVersion} + 1` }
            : {}),
        })
        .where(eq(users.id, userId))
        .returning({ sessionVersion: users.sessionVersion })
    )[0]!;

    const effects: LifecycleEffects = {
      sessionVersion: updated.sessionVersion,
      revokedConnections: [],
      disabledScheduleIds: [],
      disabledEventTriggerIds: [],
      canceledRunIds: [],
      uncanceledRunIds: [],
    };
    if (deactivating) {
      await withdrawAccess(txDb, {
        userId,
        actor,
        reason,
        status: transition.to,
        now,
        effects,
      });
    }

    await tx.insert(auditLog).values({
      actorUserId: actor.id,
      actionType: LIFECYCLE_AUDIT_ACTIONS[action],
      status: "succeeded",
      provider: "ai-hub",
      toolName: "user_lifecycle",
      input: { subjectUserId: userId },
      metadata: {
        previousStatus: target.status,
        newStatus: transition.to,
        reason,
        ...effects,
      },
      startedAt: now,
      completedAt: now,
    });

    return {
      ok: true,
      user: {
        id: userId,
        status: transition.to,
        statusChangedAt: now,
        statusReason: reason,
      },
      effects,
    };
  });
}

/** Steps 2-4 of a suspension, inside the caller's transaction. */
async function withdrawAccess(
  db: Database,
  {
    userId,
    actor,
    reason,
    status,
    now,
    effects,
  }: {
    userId: string;
    actor: SessionUser;
    reason: string;
    status: UserStatus;
    now: Date;
    effects: LifecycleEffects;
  },
): Promise<void> {
  const connections = await db
    .selectDistinct({ provider: oauthTokens.provider })
    .from(oauthTokens)
    .where(and(eq(oauthTokens.userId, userId), isNull(oauthTokens.revokedAt)));
  for (const { provider } of connections) {
    const result = await revokeOAuthConnection({
      db,
      userId,
      provider,
      actorUserId: actor.id,
      reason: `Account ${status}: ${reason}`,
      source: "user_lifecycle",
      now,
    });
    if (result.revoked) effects.revokedConnections.push(provider);
  }

  const disabledSchedules = await db
    .update(schedules)
    .set({ enabled: false, updatedAt: now })
    .where(and(eq(schedules.userId, userId), eq(schedules.enabled, true)))
    .returning({ id: schedules.id });
  effects.disabledScheduleIds.push(...disabledSchedules.map((row) => row.id));

  const disabledTriggers = await db
    .update(eventTriggers)
    .set({ enabled: false, updatedAt: now })
    .where(
      and(
        eq(eventTriggers.userId, userId),
        eq(eventTriggers.enabled, true),
        isNull(eventTriggers.deletedAt),
      ),
    )
    .returning({ id: eventTriggers.id });
  effects.disabledEventTriggerIds.push(
    ...disabledTriggers.map((row) => row.id),
  );

  const activeRuns = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(eq(runs.userId, userId), inArray(runs.status, [...ACTIVE_RUN_STATUSES])),
    );
  for (const { id } of activeRuns) {
    const result = await cancelRun({
      db,
      actor,
      runId: id,
      ownerUserId: userId,
      error: `Canceled: the account was ${status}.`,
    });
    if (result.ok && result.outcome === "canceled") {
      effects.canceledRunIds.push(id);
    } else {
      effects.uncanceledRunIds.push(id);
    }
  }
}

function refuse(
  status: 400 | 404 | 409,
  error: LifecycleError,
): LifecycleResult {
  return { ok: false, status, error };
}
