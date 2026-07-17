import { createHash } from "node:crypto";
import type { AgentEvent, ProviderRequestSnapshot } from "@ai-workspace/agent";
import { runEvents, type Database } from "@ai-workspace/db";
import { and, inArray, lt } from "drizzle-orm";
import { appendRunEventWithNextSequence } from "@/lib/run-events";
import { redactTracePayload } from "@/lib/tool-redaction";

export const RUN_TRACE_SCHEMA = "run-trace.v2" as const;
export const RUN_TRACE_SCHEMA_V1 = "run-trace.v1" as const;
export const RUN_TRACE_REDACTION_POLICY = "trace-redaction.v1" as const;
const MAX_PERSISTED_CONTEXT_BYTES = 750_000;
const MAX_REASONING_BLOCKS = 64;
const MAX_REASONING_CHARS_PER_BLOCK = 24_000;
/**
 * Standard-trace retention (#386): payload-bearing snapshot events are
 * pruned after this many days; the aggregate timing/token metrics event
 * (`provider_response_metadata`) is deliberately NOT pruned, so normalized
 * metrics outlive payloads. Enforced opportunistically on every trace
 * persist — no scheduler required. Deletion is age+eventType scoped only,
 * so it never crosses a tenant boundary it could not already reach, and
 * user deletion continues to cascade through runs → run_events.
 */
export const TRACE_PAYLOAD_RETENTION_DAYS = 30;
export const TRACE_PAYLOAD_EVENT_TYPES = [
  "provider_context_snapshot",
  "provider_reasoning",
] as const;

export function tracePayloadPruneCutoff(
  now: Date,
  retentionDays = TRACE_PAYLOAD_RETENTION_DAYS,
): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * v2 (#386) stores stable request material once per run instead of per
 * iteration: the tool catalog and system prompt live in `shared` keyed by
 * their content hashes, and — because the loop's transcript is strictly
 * append-only — every iteration's messages are a PREFIX of the final
 * iteration's, so `shared.messages` holds the final redacted transcript
 * and each request records only its prefix length. An iteration whose raw
 * messages are ever NOT a prefix (future-proofing) inlines them with
 * `messagesInline: true`.
 */
export interface CapturedProviderRequest {
  iteration: number;
  providerModelId: string;
  requestHash: string;
  systemPromptHash?: string;
  messagesHash: string;
  toolsHash: string;
  /** Prefix length into shared.messages. Absent when inlined or truncated. */
  messagesCount?: number;
  messagesInline?: boolean;
  /** Redacted per-iteration remainder (volatile suffix, inline messages). */
  request: Record<string, unknown>;
  truncated?: boolean;
  originalSizeBytes?: number;
}

export interface ProviderTraceSharedSections {
  tools: Record<string, unknown>;
  systemPrompts: Record<string, unknown>;
  /** Redacted final transcript, or a truncation stub over byte budget. */
  messages: unknown;
  messagesTruncated?: boolean;
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
  schemaVersion: 2;
  redactionPolicy: typeof RUN_TRACE_REDACTION_POLICY;
  captureMode: "standard";
  capturedAt: string;
  shared: ProviderTraceSharedSections;
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
    storage: {
      /** Bytes of the deduplicated payload this trace persists. */
      storedBytes: number;
      /** Bytes a v1 per-iteration capture of the same run would persist. */
      originalBytes: number;
    };
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
      const boundedRequests = captureDeduplicatedRequests(requests);
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
        schemaVersion: 2,
        redactionPolicy: RUN_TRACE_REDACTION_POLICY,
        captureMode: "standard",
        capturedAt: now.toISOString(),
        shared: boundedRequests.shared,
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
          storage: boundedRequests.storage,
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
      output: { shared: capture.shared, requests: capture.requests },
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

  // Retention rides on the write path so it needs no scheduler — but paced
  // and detached: the delete is table-wide (event_type + occurred_at, only
  // event_type indexed), so it fires at most once per interval per process
  // and is never awaited by the turn that triggered it.
  maybeScheduleTracePayloadPrune({ db });
}

const PRUNE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastPruneAttemptAtMs = 0;

/**
 * Fires the retention prune at most once per {@link PRUNE_MIN_INTERVAL_MS}
 * per process, fire-and-forget. Returns whether a prune was started —
 * callers never wait on it and a failure only logs (the next eligible turn
 * retries).
 */
export function maybeScheduleTracePayloadPrune({
  db,
  now = new Date(),
}: {
  db: Database;
  now?: Date;
}): boolean {
  if (now.getTime() - lastPruneAttemptAtMs < PRUNE_MIN_INTERVAL_MS) {
    return false;
  }
  lastPruneAttemptAtMs = now.getTime();
  void pruneExpiredTracePayloads({ db, now }).catch((error) => {
    process.stderr.write(
      `[provider-trace-prune-error] ${JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  });
  return true;
}

/** Test hook: clears the per-process prune pacing state. */
export function resetTracePrunePacingForTests(): void {
  lastPruneAttemptAtMs = 0;
}

/**
 * Deletes payload-bearing standard-trace events older than the retention
 * window (#386). `provider_response_metadata` (aggregate timing/tokens) is
 * exempt so normalized metrics outlive payload snapshots.
 */
export async function pruneExpiredTracePayloads({
  db,
  now = new Date(),
  retentionDays = TRACE_PAYLOAD_RETENTION_DAYS,
}: {
  db: Database;
  now?: Date;
  retentionDays?: number;
}): Promise<void> {
  const cutoff = tracePayloadPruneCutoff(now, retentionDays);
  await db
    .delete(runEvents)
    .where(
      and(
        inArray(runEvents.eventType, [...TRACE_PAYLOAD_EVENT_TYPES]),
        lt(runEvents.occurredAt, cutoff),
      ),
    );
}

function captureDeduplicatedRequests(
  raws: Array<{ iteration: number; request: ProviderRequestSnapshot }>,
): {
  shared: ProviderTraceSharedSections;
  requests: CapturedProviderRequest[];
  truncatedCount: number;
  storage: { storedBytes: number; originalBytes: number };
} {
  const shared: ProviderTraceSharedSections = {
    tools: {},
    systemPrompts: {},
    messages: [],
  };
  if (raws.length === 0) {
    return {
      shared,
      requests: [],
      truncatedCount: 0,
      storage: { storedBytes: 0, originalBytes: 0 },
    };
  }

  const finalRaw = raws[raws.length - 1]!.request;
  const finalMessagesJson = finalRaw.messages.map(stableJson);
  const redactedFinalMessages = redactTracePayload(finalRaw.messages);
  shared.messages = redactedFinalMessages;

  let originalBytes = 0;
  const requests: CapturedProviderRequest[] = raws.map(
    ({ iteration, request }) => {
      const toolsHash = sha256(request.tools);
      if (!(toolsHash in shared.tools)) {
        shared.tools[toolsHash] = redactTracePayload(request.tools);
      }
      let systemPromptHash: string | undefined;
      if (request.systemPrompt) {
        systemPromptHash = sha256(request.systemPrompt);
        if (!(systemPromptHash in shared.systemPrompts)) {
          shared.systemPrompts[systemPromptHash] = redactTracePayload(
            request.systemPrompt,
          );
        }
      }

      const isPrefix =
        request.messages.length <= finalMessagesJson.length &&
        request.messages.every(
          (message, index) => stableJson(message) === finalMessagesJson[index],
        );
      const rest: Record<string, unknown> = {
        providerModelId: request.providerModelId,
        ...(request.volatileSystemSuffix
          ? { volatileSystemSuffix: request.volatileSystemSuffix }
          : {}),
        ...(isPrefix
          ? {}
          : { messages: redactTracePayload(request.messages) }),
      };
      const redactedRest = redactTracePayload(rest);

      // What a v1 per-iteration capture would have persisted for this
      // request — the honest baseline for the storage report.
      originalBytes += jsonByteLength(redactTracePayload(request));

      return {
        iteration,
        providerModelId: request.providerModelId,
        requestHash: sha256(request),
        ...(systemPromptHash ? { systemPromptHash } : {}),
        messagesHash: sha256(request.messages),
        toolsHash,
        ...(isPrefix
          ? { messagesCount: request.messages.length }
          : { messagesInline: true }),
        request: isRecord(redactedRest) ? redactedRest : {},
      };
    },
  );

  return applyTraceByteBudget(shared, requests, originalBytes);
}

/**
 * Fixed per-run byte budget (#386). Shared sections are reserved first
 * (they are the payload the dedup exists to keep); when they alone exceed
 * the budget the transcript, then catalogs, degrade to truncation stubs.
 * Remaining budget bounds per-iteration entries newest-first, matching the
 * v1 policy of preserving the most recent context. The budget is
 * best-effort, not a hard cap: a pathological distinct-system-prompt set
 * could keep sharedBytes above the limit, but redaction's own string/array
 * caps bound every element well before that matters.
 */
function applyTraceByteBudget(
  shared: ProviderTraceSharedSections,
  requests: CapturedProviderRequest[],
  originalBytes: number,
): {
  shared: ProviderTraceSharedSections;
  requests: CapturedProviderRequest[];
  truncatedCount: number;
  storage: { storedBytes: number; originalBytes: number };
} {
  let truncatedCount = 0;

  let sharedBytes = jsonByteLength(shared);
  if (sharedBytes > MAX_PERSISTED_CONTEXT_BYTES) {
    const messagesBytes = jsonByteLength(shared.messages);
    shared.messages = {
      truncated: true,
      reason: "Standard trace context byte limit",
      originalSizeBytes: messagesBytes,
    };
    shared.messagesTruncated = true;
    sharedBytes = jsonByteLength(shared);
  }
  if (sharedBytes > MAX_PERSISTED_CONTEXT_BYTES) {
    for (const hash of Object.keys(shared.tools)) {
      const sizeBytes = jsonByteLength(shared.tools[hash]);
      shared.tools[hash] = {
        truncated: true,
        reason: "Standard trace context byte limit",
        originalSizeBytes: sizeBytes,
      };
    }
    sharedBytes = jsonByteLength(shared);
  }

  let remainingBytes = Math.max(0, MAX_PERSISTED_CONTEXT_BYTES - sharedBytes);
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

  const storedBytes = jsonByteLength({ shared, requests: bounded });
  return {
    shared,
    requests: bounded,
    truncatedCount,
    storage: { storedBytes, originalBytes },
  };
}

/**
 * Rehydrates a persisted v2 `provider_context_snapshot` output into the v1
 * per-request shape the Inspector renders — tools and system prompt from
 * the shared sections, messages from the shared transcript prefix. v1
 * payloads (no `shared` key) pass through untouched, so both schema
 * generations serve the same logical timeline.
 */
export function expandProviderContextSnapshotOutput(output: unknown): unknown {
  if (!isRecord(output) || !Array.isArray(output.requests)) return output;
  const shared = output.shared;
  if (!isRecord(shared)) return output;
  const tools = isRecord(shared.tools) ? shared.tools : {};
  const systemPrompts = isRecord(shared.systemPrompts)
    ? shared.systemPrompts
    : {};
  const transcript = Array.isArray(shared.messages) ? shared.messages : null;

  const requests = output.requests.map((entry) => {
    if (!isRecord(entry)) return entry;
    const {
      messagesCount,
      messagesInline: _messagesInline,
      request,
      ...header
    } = entry;
    const base = isRecord(request) ? request : {};
    if (typeof base.truncated === "boolean" && base.truncated) {
      return { ...header, request: base };
    }
    const messages =
      "messages" in base
        ? base.messages
        : typeof messagesCount === "number" && transcript
          ? transcript.slice(0, messagesCount)
          : {
              truncated: true,
              reason: "Shared transcript unavailable",
            };
    return {
      ...header,
      request: {
        ...base,
        messages,
        ...(typeof entry.toolsHash === "string" &&
        entry.toolsHash in tools
          ? { tools: tools[entry.toolsHash] }
          : {}),
        ...(typeof entry.systemPromptHash === "string" &&
        entry.systemPromptHash in systemPrompts
          ? { systemPrompt: systemPrompts[entry.systemPromptHash] }
          : {}),
      },
    };
  });

  return { requests };
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
