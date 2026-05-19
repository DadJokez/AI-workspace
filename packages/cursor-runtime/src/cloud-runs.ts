import { Agent } from "@cursor/sdk";
import type { RunStatus } from "@cursor/sdk";

export interface CursorCloudRunSnapshotInput {
  apiKey?: string;
  providerAgentId: string;
  providerRunId: string;
}

export type CursorCloudRunCancelInput = CursorCloudRunSnapshotInput;

export interface CursorCloudRunSnapshot {
  providerAgentId: string;
  providerRunId: string;
  status: RunStatus;
  result?: string;
  durationMs?: number;
  modelId?: string;
  createdAt?: number;
}

/**
 * Rehydrate a Cursor Cloud run by provider ids. This is the recovery path for
 * browser/App Runner disconnects: the cloud run can finish elsewhere, then AI
 * Hub can pull the terminal result back into Postgres when the thread is
 * reopened or a worker reconciles it.
 */
export async function getCursorCloudRunSnapshot({
  apiKey,
  providerAgentId,
  providerRunId,
}: CursorCloudRunSnapshotInput): Promise<CursorCloudRunSnapshot> {
  const run = await Agent.getRun(providerRunId, {
    runtime: "cloud",
    agentId: providerAgentId,
    apiKey,
  });

  let result = run.result;
  if (run.status !== "running") {
    const waited = await run.wait().catch(() => null);
    result = result ?? waited?.result;
  }
  if (!result && run.status !== "running" && run.supports("conversation")) {
    const conversation = await run.conversation().catch(() => []);
    result = extractAssistantText(conversation);
  }

  return {
    providerAgentId: run.agentId,
    providerRunId: run.id,
    status: run.status,
    ...(result ? { result } : {}),
    ...(typeof run.durationMs === "number" ? { durationMs: run.durationMs } : {}),
    ...(run.model?.id ? { modelId: run.model.id } : {}),
    ...(typeof run.createdAt === "number" ? { createdAt: run.createdAt } : {}),
  };
}

export async function cancelCursorCloudRun({
  apiKey,
  providerAgentId,
  providerRunId,
}: CursorCloudRunCancelInput): Promise<CursorCloudRunSnapshot> {
  const run = await Agent.getRun(providerRunId, {
    runtime: "cloud",
    agentId: providerAgentId,
    apiKey,
  });

  await run.cancel();

  return {
    providerAgentId: run.agentId,
    providerRunId: run.id,
    status: run.status,
    ...(typeof run.durationMs === "number" ? { durationMs: run.durationMs } : {}),
    ...(run.model?.id ? { modelId: run.model.id } : {}),
    ...(typeof run.createdAt === "number" ? { createdAt: run.createdAt } : {}),
  };
}

function extractAssistantText(conversation: unknown): string | undefined {
  if (!Array.isArray(conversation)) return undefined;
  const parts: string[] = [];
  for (const item of conversation) {
    if (!isRecord(item)) continue;
    const turn = item.turn;
    if (!isRecord(turn)) continue;
    const steps = turn.steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!isRecord(step) || step.type !== "assistantMessage") continue;
      const message = step.message;
      if (isRecord(message) && typeof message.text === "string") {
        parts.push(message.text);
      }
    }
  }
  const text = parts.join("\n\n").trim();
  return text.length > 0 ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
