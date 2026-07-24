import {
  auditLog,
  chatThreads,
  eventTriggers,
  getDb,
  skills,
} from "@ai-workspace/db";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import {
  eventTriggerKind,
  parseGitHubEventTriggerInput,
} from "@/lib/github-event-triggers";
import { ensureGitHubRepositoryWebhook } from "@/lib/github-webhook-subscriptions";
import { PUBLIC_BASE_URL } from "@/lib/oauth/github";
import { checkRateLimit } from "@/lib/request-limits";
import { canActorRunSkill } from "@/lib/shares";

export const dynamic = "force-dynamic";

const MAX_TRIGGERS_PER_USER = 50;

export async function GET(req: Request) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  const skillId = new URL(req.url).searchParams.get("skillId");
  const db = getDb();
  const rows = await db
    .select({
      id: eventTriggers.id,
      skillId: eventTriggers.skillId,
      skillName: skills.name,
      repository: eventTriggers.repository,
      eventType: eventTriggers.eventType,
      action: eventTriggers.action,
      filters: eventTriggers.filters,
      threadMode: eventTriggers.threadMode,
      targetThreadId: eventTriggers.targetThreadId,
      enabled: eventTriggers.enabled,
      lastFiredAt: eventTriggers.lastFiredAt,
      lastError: eventTriggers.lastError,
      createdAt: eventTriggers.createdAt,
    })
    .from(eventTriggers)
    .innerJoin(skills, eq(eventTriggers.skillId, skills.id))
    .where(
      and(
        eq(eventTriggers.userId, sessionUser.id),
        isNull(eventTriggers.deletedAt),
        ...(skillId ? [eq(eventTriggers.skillId, skillId)] : []),
      ),
    )
    .orderBy(desc(eventTriggers.createdAt));

  return NextResponse.json({
    triggers: rows.map((row) => ({
      ...row,
      kind: eventTriggerKind(row),
    })),
  });
}

export async function POST(req: Request) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = parseGitHubEventTriggerInput(body);
  if (!parsed.ok) {
    return NextResponse.json(
      {
        error: "invalid_event_trigger",
        field: parsed.field,
        message: parsed.message,
      },
      { status: 400 },
    );
  }

  const db = getDb();
  const rateLimit = await checkRateLimit(db, `event-trigger-create:${sessionUser.id}`, {
    maxRequestBytes: 1,
    maxMessageChars: 1,
    windowMs: 60_000,
    maxRequests: 10,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "rate_limited",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "retry-after": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  const skillRows = await db
    .select()
    .from(skills)
    .where(eq(skills.id, parsed.input.skillId))
    .limit(1);
  const skill = skillRows[0];
  if (!skill || !(await canActorRunSkill(db, skill, sessionUser))) {
    return NextResponse.json({ error: "skill_not_found" }, { status: 404 });
  }

  const countRows = await db
    .select({ value: count(eventTriggers.id) })
    .from(eventTriggers)
    .where(
      and(
        eq(eventTriggers.userId, sessionUser.id),
        isNull(eventTriggers.deletedAt),
      ),
    );
  if ((countRows[0]?.value ?? 0) >= MAX_TRIGGERS_PER_USER) {
    return NextResponse.json(
      {
        error: "trigger_limit_reached",
        message: `You can have up to ${MAX_TRIGGERS_PER_USER} active or paused event triggers.`,
      },
      { status: 409 },
    );
  }

  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json(
      {
        error: "webhook_not_configured",
        message: "GitHub event triggers are not configured yet.",
      },
      { status: 503 },
    );
  }
  const subscription = await ensureGitHubRepositoryWebhook({
    db,
    userId: sessionUser.id,
    repository: parsed.input.repository,
    webhookUrl: `${PUBLIC_BASE_URL}/api/webhooks/github`,
    secret: webhookSecret,
  });
  if (!subscription.ok) {
    return NextResponse.json(
      { error: subscription.error, message: subscription.message },
      { status: subscription.status },
    );
  }

  const trigger = await db.transaction(async (tx) => {
    let targetThreadId: string | null = null;
    if (parsed.input.threadMode === "dedicated") {
      const threadRows = await tx
        .insert(chatThreads)
        .values({
          userId: sessionUser.id,
          title: `GitHub: ${skill.name}`,
          defaultModelId: skill.modelId,
          titleSource: "manual",
        })
        .returning({ id: chatThreads.id });
      targetThreadId = threadRows[0]!.id;
    }

    const rows = await tx
      .insert(eventTriggers)
      .values({
        userId: sessionUser.id,
        skillId: skill.id,
        source: "github",
        repository: parsed.input.repository,
        eventType: parsed.input.eventType,
        action: parsed.input.action,
        filters: parsed.input.filters,
        threadMode: parsed.input.threadMode,
        targetThreadId,
      })
      .returning();
    const created = rows[0]!;
    const now = new Date();
    await tx.insert(auditLog).values({
      actorUserId: sessionUser.id,
      actionType: "event_trigger_create",
      status: "succeeded",
      provider: "github",
      toolName: skill.slug,
      input: { triggerId: created.id, skillId: skill.id },
      metadata: {
        repository: created.repository,
        eventType: created.eventType,
        action: created.action,
        filters: created.filters,
        threadMode: created.threadMode,
        githubHookId: subscription.hookId,
        githubHookCreated: subscription.created,
      },
      startedAt: now,
      completedAt: now,
    });
    return created;
  });

  return NextResponse.json(
    { trigger: { ...trigger, kind: eventTriggerKind(trigger) } },
    { status: 201 },
  );
}
