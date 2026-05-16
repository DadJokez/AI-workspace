import { DEFAULT_MODEL_ID } from "@ai-workspace/agent";
import { AuthConfigError } from "@ai-workspace/auth";
import { getRuntime } from "@ai-workspace/cursor-runtime";
import { auditLog, getDb, recipeRuns } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { buildToolAuditRows } from "@/lib/audit-tool-events";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { buildUserMcpServers } from "@/lib/oauth/mcp-servers";
import {
  checkRateLimit,
  contentLengthTooLarge,
  requestLimitConfig,
} from "@/lib/request-limits";
import { createToolEventAccumulator } from "@/lib/tool-events";

export const dynamic = "force-dynamic";

const RECIPE_SLUG = "developer-briefing";
const DEVELOPER_BRIEFING_PROMPT = [
  "Run the Developer Briefing workflow for the current user.",
  "",
  "Use the connected GitHub MCP tools. Find:",
  "1. Pull requests authored by me that need my attention.",
  "2. Review requests waiting on me.",
  "3. Pull requests or branches with failing CI/checks that I should inspect.",
  "",
  "Use @me/current-user style filters when the GitHub tools support them. If a precise query is not available, use the closest read-only GitHub tools and explain the limitation.",
  "",
  "Return concise Markdown with these sections:",
  "- Needs my attention",
  "- Waiting on my review",
  "- Failing CI",
  "- Suggested next actions",
].join("\n");

interface PostBody {
  modelId?: string;
}

export async function POST(req: Request) {
  let sessionUser;
  try {
    sessionUser = await getSessionUser();
  } catch (err) {
    if (err instanceof AuthConfigError) {
      return NextResponse.json(
        { error: "auth_config_error", message: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
  const modelId =
    typeof body.modelId === "string" && body.modelId.trim().length > 0
      ? body.modelId
      : DEFAULT_MODEL_ID;

  const db = getDb();
  const runtime = getRuntime();

  const rate = checkRateLimit(`workflow:${RECIPE_SLUG}:${sessionUser.id}`, {
    ...limits,
    maxRequests: Math.max(1, Math.floor(limits.maxRequests / 3)),
  });
  if (!rate.allowed) {
    await db.insert(auditLog).values({
      actorUserId: sessionUser.id,
      actionType: "rate_limit",
      status: "denied",
      provider: "ai-hub",
      toolName: RECIPE_SLUG,
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
    .insert(recipeRuns)
    .values({
      userId: sessionUser.id,
      recipeSlug: RECIPE_SLUG,
      triggerType: "manual",
      status: "running",
      runtime: runtime.name,
      modelId,
      inputs: { prompt: DEVELOPER_BRIEFING_PROMPT },
      startedAt: now,
      updatedAt: now,
    })
    .returning();
  const run = inserted[0]!;

  try {
    const mcpAccess = await buildUserMcpServers(db, sessionUser.id);
    const githubServer = mcpAccess.mcpServers?.github;
    if (!githubServer) {
      const reason = mcpAccess.deniedProviders.includes("github")
        ? "github_attestation_required"
        : "github_not_connected";
      await markRunFailed(run.id, reason);
      if (reason === "github_attestation_required") {
        await db.insert(auditLog).values({
          actorUserId: sessionUser.id,
          actionType: "mcp_tool_attestation",
          status: "denied",
          provider: "github",
          toolName: "*",
          recipeRunId: run.id,
          input: { provider: "github", recipeSlug: RECIPE_SLUG },
          error:
            'Tool provider "github" is connected but has no active user attestation.',
          metadata: { modelId, runtime: runtime.name },
          startedAt: new Date(),
          completedAt: new Date(),
        });
      }
      return NextResponse.json(
        {
          error: reason,
          run: { id: run.id, status: "failed", recipeSlug: RECIPE_SLUG },
        },
        { status: 400 },
      );
    }

    let briefingMarkdown = "";
    let tokensIn = 0;
    let tokensOut = 0;
    const errors: string[] = [];
    const toolEvents = createToolEventAccumulator(["github"]);

    for await (const ev of runtime.runTurn({
      threadId: `recipe-run:${run.id}`,
      modelId,
      messages: [{ role: "user", content: DEVELOPER_BRIEFING_PROMPT }],
      context: { userId: sessionUser.id },
      firstTurnPreamble:
        "You are running a saved workflow, not an open-ended chat. Use the connected GitHub tools and produce the requested briefing.",
      mcpServers: { github: githubServer },
    })) {
      if (ev.type === "text-delta") {
        briefingMarkdown += ev.delta;
      } else if (ev.type === "usage") {
        tokensIn = ev.tokensIn;
        tokensOut = ev.tokensOut;
      } else if (ev.type === "tool-call") {
        toolEvents.recordCall(ev.call);
      } else if (ev.type === "tool-result") {
        toolEvents.recordResult(ev.result);
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
      modelId,
      runtime: runtime.name,
    };

    if (errors.length > 0) {
      const message = errors.join("\n");
      await markRunFailed(run.id, message, output);
      return NextResponse.json(
        {
          error: "workflow_failed",
          message,
          run: { id: run.id, status: "failed", recipeSlug: RECIPE_SLUG },
          output,
        },
        { status: 500 },
      );
    }

    const auditRows = buildToolAuditRows({
      actorUserId: sessionUser.id,
      recipeRunId: run.id,
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
      .update(recipeRuns)
      .set({
        status: "succeeded",
        outputs: output,
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(recipeRuns.id, run.id))
      .returning();

    return NextResponse.json({
      run: serializeRun(updated[0]!),
      output,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markRunFailed(run.id, message);
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
        run: { id: run.id, status: "failed", recipeSlug: RECIPE_SLUG },
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
      .update(recipeRuns)
      .set({
        status: "failed",
        error,
        ...(output === undefined ? {} : { outputs: output }),
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(recipeRuns.id, runId));
  }
}

function serializeRun(row: typeof recipeRuns.$inferSelect) {
  return {
    id: row.id,
    recipeSlug: row.recipeSlug,
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
