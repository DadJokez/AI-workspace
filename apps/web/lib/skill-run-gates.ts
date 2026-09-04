import { auditLog, type Database } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { checkRateLimit, requestLimitConfig } from "@/lib/request-limits";
import { SETTINGS_INTEGRATIONS_PATH } from "@/lib/settings-navigation";
import type { SkillProviderAccess } from "@/lib/skills";

/**
 * Gates shared by every user-initiated skill run entry point (skill "Run",
 * schedule "Run now" — #780): one rate-limit bucket per user and one
 * actionable provider-access message, so a second entry point can never
 * become a way around either.
 */

/**
 * Skill runs can do tool work — give them the same reduced allowance the
 * Developer Briefing workflow uses (one third of the chat budget). Returns
 * the 429 response (after writing the denial audit row) when the caller's
 * bucket is exhausted; null when the run may proceed.
 */
export async function skillRunRateLimitResponse({
  db,
  userId,
  route,
}: {
  db: Database;
  userId: string;
  route: string;
}): Promise<NextResponse | null> {
  const baseLimits = requestLimitConfig();
  const rate = await checkRateLimit(db, `skill-run:${userId}`, {
    ...baseLimits,
    maxRequests: Math.max(1, Math.floor(baseLimits.maxRequests / 3)),
  });
  if (rate.allowed) return null;

  await db.insert(auditLog).values({
    actorUserId: userId,
    actionType: "rate_limit",
    status: "denied",
    provider: "ai-hub",
    toolName: "skill-run",
    input: {
      route,
      windowMs: baseLimits.windowMs,
      maxRequests: rate.limit,
    },
    error: "skill_run_rate_limit_exceeded",
    metadata: {
      retryAfterSeconds: rate.retryAfterSeconds,
      resetAt: rate.resetAt.toISOString(),
    },
    startedAt: new Date(),
    completedAt: new Date(),
  });
  return NextResponse.json(
    {
      error: "rate_limited",
      message: "Too many skill runs. Please wait a moment and try again.",
      retryAfterSeconds: rate.retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(rate.retryAfterSeconds),
        "X-RateLimit-Limit": String(rate.limit),
        "X-RateLimit-Remaining": String(rate.remaining),
        "X-RateLimit-Reset": rate.resetAt.toISOString(),
      },
    },
  );
}

/**
 * FR-004: provider gating happens before anything is enqueued, with a 409
 * body naming exactly which providers need connecting or approval.
 */
export function providerAccessRequiredBody(access: SkillProviderAccess) {
  const parts: string[] = [];
  if (access.missingConnections.length > 0) {
    parts.push(
      `connect ${access.missingConnections.join(", ")} in ${SETTINGS_INTEGRATIONS_PATH}`,
    );
  }
  if (access.deniedAttestations.length > 0) {
    parts.push(
      `approve tool access for ${access.deniedAttestations.join(", ")}`,
    );
  }
  if (access.reconnectRequired.length > 0) {
    parts.push(
      `reconnect ${access.reconnectRequired.join(", ")} in ${SETTINGS_INTEGRATIONS_PATH}`,
    );
  }
  if (access.temporarilyUnavailable.length > 0) {
    parts.push(
      `try ${access.temporarilyUnavailable.join(", ")} again in a moment`,
    );
  }
  if (access.executionUnavailable.length > 0) {
    parts.push(
      `wait for chat execution to be enabled for ${access.executionUnavailable.join(", ")}`,
    );
  }
  return {
    error: "provider_access_required",
    message: `This skill needs tools you haven't enabled yet — ${parts.join(" and ")}.`,
    missingConnections: access.missingConnections,
    deniedAttestations: access.deniedAttestations,
    executionUnavailable: access.executionUnavailable,
    reconnectRequired: access.reconnectRequired,
    temporarilyUnavailable: access.temporarilyUnavailable,
  };
}
