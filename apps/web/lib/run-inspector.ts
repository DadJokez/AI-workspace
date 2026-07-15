export interface RunInspectorRun {
  id: string;
  status: string;
  skillSlug?: string | null;
  triggerType?: string;
  runtime?: string | null;
  modelId?: string | null;
  actorEmail?: string | null;
  actorName?: string | null;
  error?: string | null;
  attemptCount?: number;
  inputs?: Record<string, unknown> | null;
  outputs?: Record<string, unknown> | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface RunInspectorEvent {
  id: string;
  sequence: number;
  eventType: string;
  status: string;
  label: string;
  provider?: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  metadata?: unknown;
  occurredAt: string;
}

export interface RunInspectorAuditEvent {
  id: string;
  actionType: string;
  status: string;
  provider?: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  metadata?: unknown;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
}

export interface RunInspectorTrace {
  schema: "run-inspector.v1";
  generatedAt: string;
  run: RunInspectorRun;
  events: RunInspectorEvent[];
  auditEvents: RunInspectorAuditEvent[];
}

export interface LiveReasoningBlock {
  iteration: number;
  blockIndex: number;
  text: string;
  redacted: boolean;
}

export function parseRunInspectorTrace(value: unknown): RunInspectorTrace | null {
  if (!isRecord(value) || value.schema !== "run-inspector.v1") return null;
  if (typeof value.generatedAt !== "string" || !isRecord(value.run)) {
    return null;
  }
  const run = parseRun(value.run);
  if (!run) return null;
  return {
    schema: "run-inspector.v1",
    generatedAt: value.generatedAt,
    run,
    events: Array.isArray(value.events)
      ? value.events.flatMap((event) => {
          const parsed = parseEvent(event);
          return parsed ? [parsed] : [];
        })
      : [],
    auditEvents: Array.isArray(value.auditEvents)
      ? value.auditEvents.flatMap((event) => {
          const parsed = parseAuditEvent(event);
          return parsed ? [parsed] : [];
        })
      : [],
  };
}

function parseRun(value: Record<string, unknown>): RunInspectorRun | null {
  if (typeof value.id !== "string" || typeof value.status !== "string") {
    return null;
  }
  return {
    id: value.id,
    status: value.status,
    skillSlug: nullableString(value.skillSlug),
    triggerType: optionalString(value.triggerType),
    runtime: nullableString(value.runtime),
    modelId: nullableString(value.modelId),
    actorEmail: nullableString(value.actorEmail),
    actorName: nullableString(value.actorName),
    error: nullableString(value.error),
    attemptCount:
      typeof value.attemptCount === "number" ? value.attemptCount : undefined,
    inputs: nullableRecord(value.inputs),
    outputs: nullableRecord(value.outputs),
    startedAt: nullableString(value.startedAt),
    completedAt: nullableString(value.completedAt),
    createdAt: optionalString(value.createdAt),
    updatedAt: optionalString(value.updatedAt),
  };
}

function parseEvent(value: unknown): RunInspectorEvent | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.sequence !== "number" ||
    typeof value.eventType !== "string" ||
    typeof value.status !== "string" ||
    typeof value.label !== "string" ||
    typeof value.occurredAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    sequence: value.sequence,
    eventType: value.eventType,
    status: value.status,
    label: value.label,
    provider: nullableString(value.provider),
    toolName: nullableString(value.toolName),
    toolCallId: nullableString(value.toolCallId),
    input: value.input,
    output: value.output,
    error: nullableString(value.error),
    metadata: value.metadata,
    occurredAt: value.occurredAt,
  };
}

function parseAuditEvent(value: unknown): RunInspectorAuditEvent | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.actionType !== "string" ||
    typeof value.status !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    actionType: value.actionType,
    status: value.status,
    provider: nullableString(value.provider),
    toolName: nullableString(value.toolName),
    toolCallId: nullableString(value.toolCallId),
    input: value.input,
    output: value.output,
    error: nullableString(value.error),
    metadata: value.metadata,
    startedAt: nullableString(value.startedAt),
    completedAt: nullableString(value.completedAt),
    createdAt: value.createdAt,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : optionalString(value);
}

function nullableRecord(
  value: unknown,
): Record<string, unknown> | null | undefined {
  return value === null ? null : isRecord(value) ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
