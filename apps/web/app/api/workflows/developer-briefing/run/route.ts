import { DEFAULT_MODEL_ID } from "@ai-workspace/agent";
import { getRuntime } from "@ai-workspace/agent-runtime";
import { auditLog, getDb, runs } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { buildToolAuditRows } from "@/lib/audit-tool-events";
import { requireSession } from "@/lib/auth/requireSession";
import {
  buildDeveloperBriefingPrompt,
  DEVELOPER_BRIEFING_SKILL_SLUG,
} from "@/lib/developer-briefing";
import { isModelEnabled, resolveModelForPurpose } from "@/lib/model-registry";
import { buildUserMcpServers } from "@/lib/oauth/mcp-servers";
import {
  checkRateLimit,
  contentLengthTooLarge,
  requestLimitConfig,
} from "@/lib/request-limits";
import { normalizeRuntimeUsage } from "@/lib/runtime-usage";
import {
  appendRunEvent,
  appendToolCallRunEvent,
  appendToolResultRunEvent,
  type AppendRunEventInput,
} from "@/lib/run-events";
import { createToolEventAccumulator } from "@/lib/tool-events";
import {
  buildWorkflowRunInputs,
  canRetryWorkflowRun,
} from "@/lib/workflow-retry";

export const dynamic = "force-dynamic";

const SKILL_SLUG = DEVELOPER_BRIEFING_SKILL_SLUG;

interface PostBody {
  modelId?: string;
  retryRunId?: string;
}

export async function POST(req: Request) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  const limits = requestLimitConfig();
  if (contentLengthTooLarge(req.headers, limits.maxRequestBytes)) {
    return NextResponse.json(
      {
        error: "request_too_large",
        message: `Request body must be ${limits.maxRequestBytes} bytes or smaller.`,
      },
      { status: 413 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as PostBody;
  const requestedModelId =
    typeof body.modelId === "string" && body.modelId.trim().length > 0
      ? body.modelId
      : DEFAULT_MODEL_ID;
  const retryRunId =
    typeof body.retryRunId === "string" && body.retryRunId.trim().length > 0
      ? body.retryRunId.trim()
      : null;

  const db = getDb();
  const modelId = (await isModelEnabled(db, requestedModelId, "durable-local"))
    ? requestedModelId
    : await resolveModelForPurpose(db, "durable-local");
  const runtime = getRuntime();
  const briefingPrompt = buildDeveloperBriefingPrompt();

  const retrySource = retryRunId
    ? await findRetrySourceRun(db, sessionUser.id, retryRunId)
    : null;
  if (retryRunId && !retrySource) {
    return NextResponse.json(
      {
        error: "retry_source_not_found",
        message: "The run to retry was not found.",
      },
      { status: 404 },
    );
  }
  if (retrySource && !canRetryWorkflowRun(retrySource.status)) {
    return NextResponse.json(
      {
        error: "retry_not_allowed",
        message: "Only failed or canceled workflow runs can be retried.",
        run: serializeRun(retrySource),
      },
      { status: 409 },
    );
  }

  const rate = await checkRateLimit(
    db,
    `workflow:${SKILL_SLUG}:${sessionUser.id}`,
    {
      ...limits,
      maxRequests: Math.max(1, Math.floor(limits.maxRequests / 3)),
    },
  );
  if (!rate.allowed) {
    await db.insert(auditLog).values({
      actorUserId: sessionUser.id,
      actionType: "rate_limit",
      status: "denied",
      provider: "ai-hub",
      toolName: SKILL_SLUG,
      input: {
        route: "/api/workflows/developer-briefing/run",
        windowMs: limits.windowMs,
        maxRequests: rate.limit,
      },
      error: "workflow_rate_limit_exceeded",
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
        message: "Too many workflow runs. Please wait a moment and try again.",
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

  const now = new Date();
  const inserted = await db
    .insert(runs)
    .values({
      userId: sessionUser.id,
      skillSlug: SKILL_SLUG,
      triggerType: retrySource ? "manual_retry" : "manual",
      status: "running",
      runtime: runtime.name,
      modelId,
      inputs: buildWorkflowRunInputs({
        prompt: briefingPrompt,
        retrySource,
        retryRequestedAt: now,
      }),
      startedAt: now,
      updatedAt: now,
    })
    .returning();
  const run = inserted[0]!;
  let runEventSequence = 0;
  const nextRunEventSequence = () => {
    runEventSequence += 1;
    return runEventSequence;
  };
  const appendWorkflowEvent = async (
    input: Omit<AppendRunEventInput, "db" | "runId" | "sequence">,
  ) => {
    try {
      await appendRunEvent({
        db,
        runId: run.id,
        sequence: nextRunEventSequence(),
        ...input,
      });
    } catch (err) {
      process.stderr.write(
        `[workflow-run-event-error] ${JSON.stringify({
          runId: run.id,
          skillSlug: SKILL_SLUG,
          eventType: input.eventType,
          message: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    }
  };
  await appendWorkflowEvent({
    eventType: "run_started",
    status: "pending",
    label: "Started Developer Briefing",
    metadata: {
      skillSlug: SKILL_SLUG,
      modelId,
      runtime: runtime.name,
      ...(retrySource ? { retryOfRunId: retrySource.id } : {}),
    },
  });

  try {
    const mcpAccess = await buildUserMcpServers(db, sessionUser.id);
    const githubServer = mcpAccess.mcpServers?.github;
    if (!githubServer) {
      const reason = mcpAccess.deniedProviders.includes("github")
        ? "github_attestation_required"
        : "github_not_connected";
      await markRunFailed(run.id, reason);
      await appendWorkflowEvent({
        eventType: "run_failed",
        status: "failed",
        label:
          reason === "github_attestation_required"
            ? "GitHub tool access needs approval"
            : "GitHub is not connected",
        error: reason,
        provider: "github",
      });
      await db.insert(auditLog).values({
        actorUserId: sessionUser.id,
        actionType:
          reason === "github_attestation_required"
            ? "mcp_tool_attestation"
            : "workflow_run",
        status: "denied",
        provider: "github",
        toolName: "*",
        runId: run.id,
        input: { provider: "github", skillSlug: SKILL_SLUG },
        error:
          reason === "github_attestation_required"
            ? 'Tool provider "github" is connected but has no active user attestation.'
            : "GitHub is not connected for this user.",
        metadata: {
          modelId,
          runtime: runtime.name,
          reason,
          ...(retrySource ? { retryOfRunId: retrySource.id } : {}),
        },
        startedAt: new Date(),
        completedAt: new Date(),
      });
      return NextResponse.json(
        {
          error: reason,
          run: {
            id: run.id,
            status: "failed",
            skillSlug: SKILL_SLUG,
            retryOfRunId: retrySource?.id ?? null,
          },
        },
        { status: 400 },
      );
    }

    let briefingMarkdown = "";
    let tokensIn = 0;
    let tokensOut = 0;
    let inputTokens = 0;
    let cacheReadInputTokens = 0;
    let cacheWriteInputTokens = 0;
    const errors: string[] = [];
    const toolEvents = createToolEventAccumulator(["github"]);

    for await (const ev of runtime.runTurn({
      threadId: `run:${run.id}`,
      modelId,
      messages: [{ role: "user", content: briefingPrompt }],
      context: { userId: sessionUser.id },
      firstTurnPreamble:
        "You are running a saved workflow, not an open-ended chat. Use the connected GitHub tools and produce the requested briefing.",
      mcpServers: { github: githubServer },
    })) {
      if (ev.type === "text-delta") {
        briefingMarkdown += ev.delta;
      } else if (ev.type === "usage") {
        const usage = normalizeRuntimeUsage(ev);
        tokensIn = usage.tokensIn;
        tokensOut = usage.tokensOut;
        inputTokens = usage.inputTokens;
        cacheReadInputTokens = usage.cacheReadInputTokens;
        cacheWriteInputTokens = usage.cacheWriteInputTokens;
      } else if (ev.type === "tool-call") {
        toolEvents.recordCall(ev.call);
        const persistedCall = toolEvents
          .calls()
          .find((call) => call.id === ev.call.id);
        if (persistedCall) {
          await appendToolCallRunEvent({
            db,
            runId: run.id,
            sequence: nextRunEventSequence(),
            call: persistedCall,
          });
        }
      } else if (ev.type === "tool-result") {
        toolEvents.recordResult(ev.result);
        const persistedResult = toolEvents
          .results()
          .find((result) => result.toolCallId === ev.result.toolCallId);
        if (persistedResult) {
          const persistedCall = toolEvents
            .calls()
            .find((call) => call.id === ev.result.toolCallId);
          await appendToolResultRunEvent({
            db,
            runId: run.id,
            sequence: nextRunEventSequence(),
            call: persistedCall,
            result: persistedResult,
          });
        }
      } else if (ev.type === "error") {
        errors.push(ev.message);
      }
    }

    const output = {
      briefingMarkdown,
      toolCalls: toolEvents.calls(),
      toolResults: toolEvents.results(),
      tokensIn,
      tokensOut,
      usage: {
        tokensIn,
        tokensOut,
        inputTokens,
        cacheReadInputTokens,
        cacheWriteInputTokens,
      },
      modelId,
      runtime: runtime.name,
    };

    if (errors.length > 0) {
      const message = errors.join("\n");
      await markRunFailed(run.id, message, output);
      await appendWorkflowEvent({
        eventType: "run_failed",
        status: "failed",
        label: "Developer Briefing failed",
        error: message,
      });
      return NextResponse.json(
        {
          error: "workflow_failed",
          message,
          run: {
            id: run.id,
            status: "failed",
            skillSlug: SKILL_SLUG,
            retryOfRunId: retrySource?.id ?? null,
          },
          output,
        },
        { status: 500 },
      );
    }

    const auditRows = buildToolAuditRows({
      actorUserId: sessionUser.id,
      runId: run.id,
      modelId,
      runtime: runtime.name,
      calls: toolEvents.calls(),
      results: toolEvents.results(),
    });
    if (auditRows.length > 0) {
      await db.insert(auditLog).values(auditRows);
    }

    const completedAt = new Date();
    const updated = await db
      .update(runs)
      .set({
        status: "succeeded",
        outputs: output,
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(runs.id, run.id))
      .returning();
    await appendWorkflowEvent({
      eventType: "run_completed",
      status: "succeeded",
      label: "Stored Developer Briefing",
      metadata: { outputChars: briefingMarkdown.length },
    });

    return NextResponse.json({
      run: {
        ...serializeRun(updated[0]!),
        retryOfRunId: retrySource?.id ?? null,
      },
      output,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markRunFailed(run.id, message);
    await appendWorkflowEvent({
      eventType: "run_failed",
      status: "failed",
      label: "Developer Briefing failed",
      error: message,
      metadata: { failureSite: "route" },
    });
    process.stderr.write(
      `[developer-briefing-error] ${JSON.stringify({
        runId: run.id,
        userId: sessionUser.id,
        message,
        stack: err instanceof Error ? err.stack : undefined,
      })}\n`,
    );
    return NextResponse.json(
      {
        error: "workflow_failed",
        message,
        run: {
          id: run.id,
          status: "failed",
          skillSlug: SKILL_SLUG,
          retryOfRunId: retrySource?.id ?? null,
        },
      },
      { status: 500 },
    );
  }

  async function markRunFailed(
    runId: string,
    error: string,
    output?: unknown,
  ): Promise<void> {
    const completedAt = new Date();
    await db
      .update(runs)
      .set({
        status: "failed",
        error,
        ...(output === undefined ? {} : { outputs: output }),
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(runs.id, runId));
  }
}

async function findRetrySourceRun(
  db: ReturnType<typeof getDb>,
  userId: string,
  runId: string,
) {
  const rows = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.userId, userId),
        eq(runs.skillSlug, SKILL_SLUG),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function serializeRun(row: typeof runs.$inferSelect) {
  return {
    id: row.id,
    skillSlug: row.skillSlug,
    status: row.status,
    triggerType: row.triggerType,
    runtime: row.runtime,
    modelId: row.modelId,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
