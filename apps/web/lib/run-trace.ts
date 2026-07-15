import { createHash } from "node:crypto";
import type { AgentEvent, ProviderRequestSnapshot } from "@ai-workspace/agent";
import type { Database } from "@ai-workspace/db";
import { appendRunEventWithNextSequence } from "@/lib/run-events";
import { redactTracePayload } from "@/lib/tool-redaction";

export const RUN_TRACE_SCHEMA = "run-trace.v1" as const;
export const RUN_TRACE_REDACTION_POLICY = "trace-redaction.v1" as const;
const MAX_PERSISTED_CONTEXT_BYTES = 750_000;
const MAX_REASONING_BLOCKS = 64;
const MAX_REASONING_CHARS_PER_BLOCK = 24_000;

export interface CapturedProviderRequest {
  iteration: number;
  providerModelId: string;
  requestHash: string;
  systemPromptHash?: string;
  messagesHash: string;
  toolsHash: string;
  request: Record<string, unknown>;
  truncated?: boolean;
  originalSizeBytes?: number;
}

export interface CapturedReasoningBlock {
  iteration: number;
  blockIndex: number;
  text?: string;
  textHash?: string;
  redacted: boolean;
  truncated?: boolean;
}

export interface CapturedProviderMetadata {
  iteration: number;
  stopReason?: string;
  latencyMs?: number;
  performanceLatency?: string;
  serviceTier?: string;
  additionalModelResponseFields?: unknown;
}

export interface ProviderTraceCapture {
  schema: typeof RUN_TRACE_SCHEMA;
  schemaVersion: 1;
  redactionPolicy: typeof RUN_TRACE_REDACTION_POLICY;
  captureMode: "standard";
  capturedAt: string;
  requests: CapturedProviderRequest[];
  reasoning: {
    state: "available" | "redacted" | "absent";
    blocks: CapturedReasoningBlock[];
  };
  responseMetadata: CapturedProviderMetadata[];
  limits: {
    contextByteLimit: number;
    reasoningBlockLimit: number;
    reasoningCharsPerBlock: number;
    truncatedRequestCount: number;
    truncatedReasoningBlockCount: number;
  };
}

export interface PersistedTraceEvent {
  eventType: string;
  status: "info" | "succeeded";
  label: string;
  provider: string;
  output: unknown;
  metadata: Record<string, unknown>;
}

interface MutableReasoningBlock {
  iteration: number;
  blockIndex: number;
  text: string;
  redacted: boolean;
  truncated: boolean;
}

export function createProviderTraceAccumulator() {
  const requests: Array<{ iteration: number; request: ProviderRequestSnapshot }> = [];
  const reasoning = new Map<string, MutableReasoningBlock>();
  const responseMetadata = new Map<number, CapturedProviderMetadata>();
  const omittedReasoningKeys = new Set<string>();

  return {
    record(event: AgentEvent): void {
      if (event.type === "provider-request") {
        requests.push({ iteration: event.iteration, request: event.request });
        return;
      }
      if (event.type === "provider-reasoning-delta") {
        const key = reasoningKey(event.iteration, event.blockIndex);
        if (!reasoning.has(key) && reasoning.size >= MAX_REASONING_BLOCKS) {
          omittedReasoningKeys.add(key);
          return;
        }
        const block = reasoning.get(key) ?? {
          iteration: event.iteration,
          blockIndex: event.blockIndex,
          text: "",
          redacted: false,
          truncated: false,
        };
        const remaining = MAX_REASONING_CHARS_PER_BLOCK - block.text.length;
        if (remaining > 0) block.text += event.delta.slice(0, remaining);
        if (event.delta.length > remaining) block.truncated = true;
        reasoning.set(key, block);
        return;
      }
      if (event.type === "provider-reasoning-redacted") {
        const key = reasoningKey(event.iteration, event.blockIndex);
        if (!reasoning.has(key) && reasoning.size >= MAX_REASONING_BLOCKS) {
          omittedReasoningKeys.add(key);
          return;
        }
        const block = reasoning.get(key) ?? {
          iteration: event.iteration,
          blockIndex: event.blockIndex,
          text: "",
          redacted: false,
          truncated: false,
        };
        block.redacted = true;
        reasoning.set(key, block);
        return;
      }
      if (event.type === "provider-response-metadata") {
        const current = responseMetadata.get(event.iteration) ?? {
          iteration: event.iteration,
        };
        responseMetadata.set(event.iteration, {
          ...current,
          ...definedValues(event),
          iteration: event.iteration,
        });
      }
    },

    snapshot(now = new Date()): ProviderTraceCapture {
      const boundedRequests = boundCapturedRequests(
        requests.map(({ iteration, request }) =>
          captureProviderRequest(iteration, request),
        ),
      );
      const blocks = [...reasoning.values()]
        .sort(
          (left, right) =>
            left.iteration - right.iteration ||
            left.blockIndex - right.blockIndex,
        )
        .map(captureReasoningBlock);
      const state = blocks.some((block) => Boolean(block.text))
        ? "available"
        : blocks.some((block) => block.redacted)
          ? "redacted"
          : "absent";

      return {
        schema: RUN_TRACE_SCHEMA,
        schemaVersion: 1,
        redactionPolicy: RUN_TRACE_REDACTION_POLICY,
        captureMode: "standard",
        capturedAt: now.toISOString(),
        requests: boundedRequests.requests,
        reasoning: { state, blocks },
        responseMetadata: [...responseMetadata.values()].sort(
          (left, right) => left.iteration - right.iteration,
        ),
        limits: {
          contextByteLimit: MAX_PERSISTED_CONTEXT_BYTES,
          reasoningBlockLimit: MAX_REASONING_BLOCKS,
          reasoningCharsPerBlock: MAX_REASONING_CHARS_PER_BLOCK,
          truncatedRequestCount: boundedRequests.truncatedCount,
          truncatedReasoningBlockCount:
            omittedReasoningKeys.size +
            blocks.filter((block) => block.truncated).length,
        },
      };
    },
  };
}

export function buildPersistedTraceEvents(
  capture: ProviderTraceCapture,
): PersistedTraceEvent[] {
  const providerModelId = capture.requests[0]?.providerModelId;
  const sharedMetadata = {
    schema: capture.schema,
    schemaVersion: capture.schemaVersion,
    redactionPolicy: capture.redactionPolicy,
    captureMode: capture.captureMode,
    capturedAt: capture.capturedAt,
    ...(providerModelId ? { providerModelId } : {}),
    limits: capture.limits,
  };
  const reasoningLabel =
    capture.reasoning.state === "available"
      ? `Captured ${capture.reasoning.blocks.length} provider reasoning block${capture.reasoning.blocks.length === 1 ? "" : "s"}`
      : capture.reasoning.state === "redacted"
        ? "Provider returned encrypted reasoning"
        : "Provider returned no inspectable reasoning";

  return [
    {
      eventType: "provider_context_snapshot",
      status: "succeeded",
      label: `Captured ${capture.requests.length} provider request snapshot${capture.requests.length === 1 ? "" : "s"}`,
      provider: "bedrock",
      output: { requests: capture.requests },
      metadata: sharedMetadata,
    },
    {
      eventType: "provider_reasoning",
      status: capture.reasoning.state === "absent" ? "info" : "succeeded",
      label: reasoningLabel,
      provider: "bedrock",
      output: capture.reasoning,
      metadata: sharedMetadata,
    },
    {
      eventType: "provider_response_metadata",
      status: "succeeded",
      label: "Captured provider response metadata",
      provider: "bedrock",
      output: { responses: capture.responseMetadata },
      metadata: sharedMetadata,
    },
  ];
}

export async function persistProviderTraceCapture({
  db,
  runId,
  capture,
}: {
  db: Database;
  runId: string;
  capture: ProviderTraceCapture;
}): Promise<void> {
  if (
    capture.requests.length === 0 &&
    capture.reasoning.blocks.length === 0 &&
    capture.responseMetadata.length === 0
  ) {
    return;
  }

  try {
    for (const event of buildPersistedTraceEvents(capture)) {
      await appendRunEventWithNextSequence({
        db,
        runId,
        ...event,
        redactionProfile: "trace",
      });
    }
  } catch (error) {
    process.stderr.write(
      `[provider-trace-persist-error] ${JSON.stringify({
        runId,
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
}

function captureProviderRequest(
  iteration: number,
  request: ProviderRequestSnapshot,
): CapturedProviderRequest {
  const redacted = redactTracePayload(request);
  const safeRequest = isRecord(redacted) ? redacted : {};
  return {
    iteration,
    providerModelId: request.providerModelId,
    requestHash: sha256(request),
    ...(request.systemPrompt
      ? { systemPromptHash: sha256(request.systemPrompt) }
      : {}),
    messagesHash: sha256(request.messages),
    toolsHash: sha256(request.tools),
    request: safeRequest,
  };
}

function captureReasoningBlock(
  block: MutableReasoningBlock,
): CapturedReasoningBlock {
  const safeText = block.text
    ? redactTracePayload(block.text)
    : undefined;
  return {
    iteration: block.iteration,
    blockIndex: block.blockIndex,
    ...(typeof safeText === "string" && safeText.length > 0
      ? {
          text: block.truncated
            ? `${safeText}\n\n[truncated by standard trace policy]`
            : safeText,
          textHash: sha256(block.text),
        }
      : {}),
    redacted: block.redacted,
    ...(block.truncated ? { truncated: true } : {}),
  };
}

function boundCapturedRequests(requests: CapturedProviderRequest[]): {
  requests: CapturedProviderRequest[];
  truncatedCount: number;
} {
  let remainingBytes = MAX_PERSISTED_CONTEXT_BYTES;
  let truncatedCount = 0;
  const bounded = new Array<CapturedProviderRequest>(requests.length);

  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index]!;
    const sizeBytes = jsonByteLength(request.request);
    if (sizeBytes <= remainingBytes) {
      bounded[index] = request;
      remainingBytes -= sizeBytes;
      continue;
    }

    truncatedCount += 1;
    bounded[index] = {
      ...request,
      request: {
        truncated: true,
        reason: "Standard trace context byte limit",
        originalSizeBytes: sizeBytes,
      },
      truncated: true,
      originalSizeBytes: sizeBytes,
    };
  }

  return { requests: bounded, truncatedCount };
}

function reasoningKey(iteration: number, blockIndex: number): string {
  return `${iteration}:${blockIndex}`;
}

function sha256(value: unknown): string {
  const serialized = typeof value === "string" ? value : stableJson(value);
  return createHash("sha256").update(serialized).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

function definedValues(
  value: object,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([, item]) => item !== undefined,
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
