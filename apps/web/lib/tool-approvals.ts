import { randomUUID } from "node:crypto";
import type {
  ToolApprovalGrant,
  ToolApprovalRequest as AgentToolApprovalRequest,
} from "@ai-workspace/agent";
import {
  auditLog,
  type Database,
  runs,
  toolApprovalRequests,
} from "@ai-workspace/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PersistedToolCall, PersistedToolResult } from "@/lib/tool-events";

export type PublicToolApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired";

export interface PublicToolApprovalRequest {
  id: string;
  batchId: string;
  toolCallId: string;
  toolName: string;
  provider: string | null;
  nativeToolName: string | null;
  redactedInput: unknown;
  status: PublicToolApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
}

export type ToolApprovalDecision = "approve" | "deny";

export type DecideToolApprovalsResult =
  | {
      ok: true;
      queued: boolean;
      approvals: PublicToolApprovalRequest[];
      decided: PublicToolApprovalRequest[];
    }
  | { ok: false; status: number; error: string; message: string };

export async function loadToolApprovalGrants({
  db,
  runId,
  userId,
  runOutputs,
}: {
  db: Database;
  runId: string;
  userId: string;
  runOutputs: unknown;
}): Promise<ToolApprovalGrant[]> {
  if (
    !isRecord(runOutputs) ||
    !Array.isArray(runOutputs.approvalRequests) ||
    runOutputs.approvalRequests.length === 0
  ) {
    return [];
  }
  const persistedApprovalRequests = runOutputs.approvalRequests as unknown[];
  // Claim every newly decided receipt in the same transaction that reads it.
  // The returned grant preserves the pre-claim state so this invocation may
  // execute once; a retry observes consumedAt and replays instead.
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: toolApprovalRequests.id,
        callFingerprint: toolApprovalRequests.callFingerprint,
        status: toolApprovalRequests.status,
        consumedAt: toolApprovalRequests.consumedAt,
      })
      .from(toolApprovalRequests)
      .where(
        and(
          eq(toolApprovalRequests.runId, runId),
          eq(toolApprovalRequests.userId, userId),
          inArray(toolApprovalRequests.status, ["approved", "denied"]),
        ),
      )
      .for("update");
    const unclaimedIds = rows
      .filter((row) => row.consumedAt === null)
      .map((row) => row.id);
    if (unclaimedIds.length > 0) {
      const now = new Date();
      await tx
        .update(toolApprovalRequests)
        .set({ consumedAt: now, updatedAt: now })
        .where(
          and(
            eq(toolApprovalRequests.runId, runId),
            eq(toolApprovalRequests.userId, userId),
            inArray(toolApprovalRequests.id, unclaimedIds),
            isNull(toolApprovalRequests.consumedAt),
          ),
        );
    }
    // Provider tool-call ids regenerate when a paused run resumes. Preserve
    // the original batch order so duplicate fingerprints still consume one
    // distinct receipt each without depending on those ephemeral ids.
    const approvalOrder = new Map<string, number>(
      persistedApprovalRequests.flatMap((request, index) =>
        isRecord(request) && typeof request.id === "string"
          ? [[request.id, index] as const]
          : [],
      ),
    );
    const orderedRows = [...rows].sort(
      (left, right) =>
        (approvalOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (approvalOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    );
    const results = toolResultsFromOutputs(runOutputs);
    return orderedRows.map((row) => {
      const replayResult = results.find(
        (result) => result.approvalId === row.id,
      );
      return {
        schema: "comparative.tool-approval-grant.v1",
        approvalId: row.id,
        fingerprint: row.callFingerprint,
        decision: row.status === "approved" ? "approved" : "denied",
        ...(row.consumedAt ? { consumed: true } : {}),
        ...(replayResult ? { replayOutput: replayResult.output } : {}),
      };
    });
  });
}

export async function pauseRunForToolApprovals({
  db,
  runId,
  userId,
  threadId,
  requests,
  calls,
  outputs,
  expectedWorkerId,
}: {
  db: Database;
  runId: string;
  userId: string;
  threadId: string;
  requests: readonly AgentToolApprovalRequest[];
  calls: readonly PersistedToolCall[];
  outputs: Record<string, unknown>;
  expectedWorkerId?: string;
}): Promise<PublicToolApprovalRequest[]> {
  if (requests.length === 0) return [];
  const now = new Date();
  const batchId = randomUUID();
  const callsById = new Map(calls.map((call) => [call.id, call]));

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(toolApprovalRequests)
      .values(
        requests.map((request) => {
          const call = callsById.get(request.toolCallId);
          if (!call) {
            throw new Error(
              `Approval request ${request.toolCallId} has no persisted tool call.`,
            );
          }
          return {
            batchId,
            runId,
            userId,
            threadId,
            toolCallId: request.toolCallId,
            toolName: request.toolName,
            provider: request.identity?.provider ?? call.provider,
            endpoint: request.identity?.endpoint,
            nativeToolName:
              request.identity?.nativeToolName ?? call.toolName,
            callFingerprint: request.fingerprint,
            redactedInput: call.input,
            status: "pending" as const,
            requestedAt: now,
            createdAt: now,
            updatedAt: now,
          };
        }),
      )
      .returning();
    const approvals = inserted.map(serializeToolApprovalRequest);
    const scope = expectedWorkerId
      ? and(
          eq(runs.id, runId),
          eq(runs.userId, userId),
          eq(runs.status, "running"),
          eq(runs.workerId, expectedWorkerId),
        )
      : and(
          eq(runs.id, runId),
          eq(runs.userId, userId),
          eq(runs.status, "running"),
        );
    const updated = await tx
      .update(runs)
      .set({
        status: "waiting_for_approval",
        outputs: {
          ...outputs,
          lifecycle: "waiting_for_approval",
          approvalRequests: approvals,
        },
        workerId: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: now,
        attemptCount: sql`greatest(${runs.attemptCount} - 1, 0)`,
        updatedAt: now,
      })
      .where(scope)
      .returning({ id: runs.id });
    if (updated.length === 0) {
      throw new Error("The run stopped before its approval request was saved.");
    }
    return approvals;
  });
}

export async function decideToolApprovals({
  db,
  runId,
  userId,
  approvalIds,
  decision,
}: {
  db: Database;
  runId: string;
  userId: string;
  approvalIds: readonly string[];
  decision: ToolApprovalDecision;
}): Promise<DecideToolApprovalsResult> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const runRows = await tx
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.userId, userId)))
      .limit(1)
      .for("update");
    const run = runRows[0];
    if (!run) {
      return {
        ok: false,
        status: 404,
        error: "run_not_found",
        message: "That run was not found.",
      };
    }
    if (run.status !== "waiting_for_approval") {
      return {
        ok: false,
        status: 409,
        error: "run_not_waiting_for_approval",
        message: "This run is no longer waiting for approval.",
      };
    }
    const selected = await tx
      .select()
      .from(toolApprovalRequests)
      .where(
        and(
          eq(toolApprovalRequests.runId, runId),
          eq(toolApprovalRequests.userId, userId),
          eq(toolApprovalRequests.status, "pending"),
          inArray(toolApprovalRequests.id, [...approvalIds]),
        ),
      )
      .for("update");
    if (selected.length !== approvalIds.length) {
      return {
        ok: false,
        status: 409,
        error: "approval_not_pending",
        message: "One or more approval requests have already been decided.",
      };
    }

    const nextStatus = decision === "approve" ? "approved" : "denied";
    await tx
      .update(toolApprovalRequests)
      .set({
        status: nextStatus,
        decidedAt: now,
        decidedByUserId: userId,
        updatedAt: now,
      })
      .where(
        and(
          eq(toolApprovalRequests.runId, runId),
          eq(toolApprovalRequests.userId, userId),
          eq(toolApprovalRequests.status, "pending"),
          inArray(toolApprovalRequests.id, [...approvalIds]),
        ),
      );

    await tx.insert(auditLog).values(
      selected.map((approval) => ({
        actorUserId: userId,
        actionType: "tool_approval_decision",
        status:
          decision === "approve"
            ? ("succeeded" as const)
            : ("denied" as const),
        provider: approval.provider,
        toolName: approval.nativeToolName ?? approval.toolName,
        toolCallId: approval.toolCallId,
        chatThreadId: approval.threadId,
        runId,
        input: approval.redactedInput,
        output: { approvalId: approval.id, decision },
        policyDecision:
          decision === "approve" ? ("approved_by_user" as const) : ("denied" as const),
        metadata: {
          batchId: approval.batchId,
          callFingerprint: approval.callFingerprint,
        },
        startedAt: now,
        completedAt: now,
      })),
    );

    const allRows = await tx
      .select()
      .from(toolApprovalRequests)
      .where(eq(toolApprovalRequests.runId, runId));
    const approvals = allRows.map(serializeToolApprovalRequest);
    const pending = allRows.some((approval) => approval.status === "pending");
    const currentOutputs = isRecord(run.outputs) ? run.outputs : {};
    await tx
      .update(runs)
      .set({
        ...(pending
          ? {}
          : {
              status: "queued" as const,
              workerId: null,
              leaseExpiresAt: null,
              completedAt: null,
              error: null,
            }),
        outputs: {
          ...currentOutputs,
          lifecycle: pending ? "waiting_for_approval" : "approval_decided",
          approvalRequests: approvals,
        },
        updatedAt: now,
      })
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.userId, userId),
          eq(runs.status, "waiting_for_approval"),
        ),
      );
    const decidedIds = new Set(approvalIds);
    return {
      ok: true,
      queued: !pending,
      approvals,
      decided: approvals.filter((approval) => decidedIds.has(approval.id)),
    };
  });
}

export function parsePublicToolApprovalRequests(
  value: unknown,
): PublicToolApprovalRequest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    if (
      typeof item.id !== "string" ||
      typeof item.batchId !== "string" ||
      typeof item.toolCallId !== "string" ||
      typeof item.toolName !== "string" ||
      typeof item.requestedAt !== "string" ||
      !isPublicStatus(item.status)
    ) {
      return [];
    }
    return [
      {
        id: item.id,
        batchId: item.batchId,
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        provider: typeof item.provider === "string" ? item.provider : null,
        nativeToolName:
          typeof item.nativeToolName === "string" ? item.nativeToolName : null,
        redactedInput: item.redactedInput,
        status: item.status,
        requestedAt: item.requestedAt,
        ...(typeof item.decidedAt === "string"
          ? { decidedAt: item.decidedAt }
          : {}),
      },
    ];
  });
}

function serializeToolApprovalRequest(
  row: typeof toolApprovalRequests.$inferSelect,
): PublicToolApprovalRequest {
  return {
    id: row.id,
    batchId: row.batchId,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    provider: row.provider,
    nativeToolName: row.nativeToolName,
    redactedInput: row.redactedInput,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
  };
}

function toolResultsFromOutputs(value: unknown): PersistedToolResult[] {
  if (!isRecord(value) || !Array.isArray(value.toolResults)) return [];
  return value.toolResults as PersistedToolResult[];
}

function isPublicStatus(value: unknown): value is PublicToolApprovalStatus {
  return (
    value === "pending" ||
    value === "approved" ||
    value === "denied" ||
    value === "expired"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
