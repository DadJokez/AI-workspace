import { UnauthorizedError } from "@ai-workspace/auth";
import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { startInProcessChatRunWorker } from "@/lib/chat-run-worker";
import { appendRunEventBestEffort } from "@/lib/run-events";
import {
  decideToolApprovals,
  type ToolApprovalDecision,
} from "@/lib/tool-approvals";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_APPROVALS_PER_DECISION = 25;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: runId } = await params;
  try {
    const session = await requireSession();
    if ("error" in session) return session.error;
    const parsed = await parseDecisionBody(req);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error, message: parsed.message },
        { status: 400 },
      );
    }

    const db = getDb();
    const result = await decideToolApprovals({
      db,
      runId,
      userId: session.user.id,
      approvalIds: parsed.approvalIds,
      decision: parsed.decision,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, message: result.message },
        { status: result.status },
      );
    }

    for (const approval of result.decided) {
      await appendRunEventBestEffort("tool-approval-event-error", {
        db,
        runId,
        eventType: "tool_approval_decided",
        status: parsed.decision === "approve" ? "succeeded" : "info",
        label:
          parsed.decision === "approve"
            ? `Approved ${approval.nativeToolName ?? approval.toolName}`
            : `Denied ${approval.nativeToolName ?? approval.toolName}`,
        provider: approval.provider,
        toolName: approval.nativeToolName ?? approval.toolName,
        toolCallId: approval.toolCallId,
        metadata: {
          approvalId: approval.id,
          batchId: approval.batchId,
          decision: parsed.decision,
        },
      });
    }
    if (result.queued) {
      await appendRunEventBestEffort("tool-approval-event-error", {
        db,
        runId,
        eventType: "run_requeued_after_approval",
        status: "pending",
        label: "Approval decision saved; continuing the run",
      });
      startInProcessChatRunWorker({ db, runId });
    }

    return NextResponse.json({
      run: {
        id: runId,
        status: result.queued ? "queued" : "waiting_for_approval",
      },
      approvals: result.approvals,
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }
}

async function parseDecisionBody(req: Request): Promise<
  | {
      ok: true;
      decision: ToolApprovalDecision;
      approvalIds: string[];
    }
  | { ok: false; error: string; message: string }
> {
  const body = (await req.json().catch(() => null)) as unknown;
  if (!isRecord(body)) {
    return {
      ok: false,
      error: "invalid_body",
      message: "A JSON decision body is required.",
    };
  }
  if (body.decision !== "approve" && body.decision !== "deny") {
    return {
      ok: false,
      error: "invalid_decision",
      message: "Decision must be approve or deny.",
    };
  }
  if (
    !Array.isArray(body.approvalIds) ||
    body.approvalIds.length === 0 ||
    body.approvalIds.length > MAX_APPROVALS_PER_DECISION ||
    body.approvalIds.some(
      (approvalId) =>
        typeof approvalId !== "string" || !UUID_PATTERN.test(approvalId),
    )
  ) {
    return {
      ok: false,
      error: "invalid_approval_ids",
      message: `Choose between 1 and ${MAX_APPROVALS_PER_DECISION} approval requests.`,
    };
  }
  const approvalIds = [...new Set(body.approvalIds as string[])];
  if (approvalIds.length !== body.approvalIds.length) {
    return {
      ok: false,
      error: "duplicate_approval_ids",
      message: "Approval request IDs must be unique.",
    };
  }
  return { ok: true, decision: body.decision, approvalIds };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
