import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";

const REDACTED = "[redacted]";
const TRUNCATED = "[truncated]";
const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 8;

interface RedactionLimits {
  maxStringLength: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  maxDepth: number;
}

const TOOL_LIMITS: RedactionLimits = {
  maxStringLength: MAX_STRING_LENGTH,
  maxArrayItems: MAX_ARRAY_ITEMS,
  maxObjectKeys: MAX_OBJECT_KEYS,
  maxDepth: MAX_DEPTH,
};

const TRACE_LIMITS: RedactionLimits = {
  maxStringLength: 24_000,
  maxArrayItems: 200,
  maxObjectKeys: 200,
  maxDepth: 10,
};

const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(access|api|auth|bearer|client|cookie|encryption|jwt|key|oauth|password|private|refresh|secret|session|signature|token)([_-]|$)|authorization|set-cookie|x[-_]comparative[-_]resource[-_](relay|context)/i;

/**
 * Observability keys where "token" means model tokens, not credentials
 * (#387): first-token latency stamps and spans. They bypass KEY-based
 * redaction only — and only when the value is plainly telemetry (number,
 * boolean, or a short ISO-ish timestamp). String payloads still run full
 * value-based redaction, so a credential smuggled under a telemetry name
 * never survives. Matched on the same snake-normalized key as
 * SENSITIVE_KEY_PATTERN.
 */
const SAFE_TELEMETRY_KEY_PATTERN =
  /(^|_)(first_token_(at|ms)|(request|provider)_to_first_token_ms)$/i;

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

export function redactToolCall(call: PersistedToolCall): PersistedToolCall {
  return {
    ...call,
    input: redactToolPayload(call.input) as Record<string, unknown>,
  };
}

export function redactToolResult(
  result: PersistedToolResult,
): PersistedToolResult {
  return {
    ...result,
    output: redactToolPayload(result.output),
  };
}

export function redactToolPayload(value: unknown): unknown {
  return redactValue(value, 0, TOOL_LIMITS);
}

export function redactTracePayload(value: unknown): unknown {
  return redactValue(value, 0, TRACE_LIMITS);
}

export function redactErrorText(value: unknown): string {
  const redacted = redactToolPayload(value);
  const text =
    typeof redacted === "string" ? redacted : safeJsonStringify(redacted);
  return truncateString(text);
}

export function redactProviderToolError(
  provider: string | null | undefined,
  value: unknown,
): string {
  if (provider === "google") {
    return "Google tool failed; provider content was redacted from this log.";
  }
  if (provider === "salesforce") {
    return "Salesforce tool failed; provider content was redacted from this log.";
  }
  if (provider === "resources") {
    return "Conversation resource tool failed; file content was redacted from this log.";
  }
  return redactErrorText(value);
}

export function redactProviderToolPayload({
  provider,
  toolName,
  direction,
  value,
}: {
  provider: string | null | undefined;
  toolName: string | null | undefined;
  direction: "input" | "output";
  value: unknown;
}): unknown {
  if (
    provider !== "google" &&
    provider !== "salesforce" &&
    provider !== "resources"
  ) {
    return redactToolPayload(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { redacted: true };
  }
  const payload = value as Record<string, unknown>;
  if (provider === "resources") {
    if (direction === "input") {
      return {
        redacted: true,
        resourceId:
          typeof payload.resourceId === "string"
            ? payload.resourceId
            : undefined,
        operation:
          typeof payload.operation === "string" ? payload.operation : undefined,
        fields: Object.keys(payload).sort(),
      };
    }
    const receipt =
      payload.receipt &&
      typeof payload.receipt === "object" &&
      !Array.isArray(payload.receipt)
        ? redactToolPayload(payload.receipt)
        : undefined;
    return {
      redacted: true,
      kind: typeof payload.kind === "string" ? payload.kind : undefined,
      receipt,
      rowCount:
        typeof payload.rowCount === "number" ? payload.rowCount : undefined,
      value:
        typeof payload.value === "number" ? payload.value : undefined,
      resultKeys: Object.keys(payload).sort(),
    };
  }
  if (direction === "input") {
    return {
      redacted: true,
      fields: Object.keys(payload).sort(),
      ...(toolName === "create_draft"
        ? {
            recipientCount: arrayLength(payload.to),
            ccCount: arrayLength(payload.cc),
            bccCount: arrayLength(payload.bcc),
            subjectLength: stringLength(payload.subject),
            bodyLength: stringLength(payload.body),
            replyContext: Boolean(payload.threadId || payload.inReplyTo),
          }
        : {}),
      ...(toolName === "prepare_event"
        ? {
            attendeeCount: arrayLength(payload.attendees),
            descriptionLength: stringLength(payload.description),
            hasLocation: typeof payload.location === "string",
            sendInvitations: payload.sendInvitations === true,
          }
        : {}),
    };
  }
  return {
    redacted: true,
    kind: typeof payload.kind === "string" ? payload.kind : undefined,
    sent: typeof payload.sent === "boolean" ? payload.sent : undefined,
    invitationsSent:
      typeof payload.invitationsSent === "boolean"
        ? payload.invitationsSent
        : undefined,
    idempotentReplay:
      typeof payload.idempotentReplay === "boolean"
        ? payload.idempotentReplay
        : undefined,
  };
}

function redactValue(
  value: unknown,
  depth: number,
  limits: RedactionLimits,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return redactString(value, depth, limits);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (depth >= limits.maxDepth) return TRUNCATED;

  if (Array.isArray(value)) {
    const out = value
      .slice(0, limits.maxArrayItems)
      .map((item) => redactValue(item, depth + 1, limits));
    if (value.length > limits.maxArrayItems) out.push(TRUNCATED);
    return out;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, limits.maxObjectKeys)) {
      out[key] =
        isSensitiveKey(key) && !isSafeTelemetryEntry(key, item)
          ? REDACTED
          : redactValue(item, depth + 1, limits);
    }
    if (entries.length > limits.maxObjectKeys) out.__truncated = true;
    return out;
  }

  return String(value);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(normalizeKey(key));
}

function normalizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
}

function isSafeTelemetryEntry(key: string, value: unknown): boolean {
  if (!SAFE_TELEMETRY_KEY_PATTERN.test(normalizeKey(key))) return false;
  if (value === null || value === undefined) return true;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (value instanceof Date) return true;
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    ISO_TIMESTAMP_PATTERN.test(value)
  );
}

function redactString(
  value: string,
  depth: number,
  limits: RedactionLimits,
): string {
  if (looksLikeSecret(value)) return REDACTED;
  const structured = parseStructuredJson(value);
  if (structured !== undefined) {
    return truncateString(
      JSON.stringify(redactValue(structured, depth + 1, limits)),
      limits.maxStringLength,
    );
  }
  return truncateString(
    redactInlineSecrets(value),
    limits.maxStringLength,
  );
}

function parseStructuredJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function looksLikeSecret(value: string): boolean {
  const trimmed = value.trim();
  if (/^bearer\s+[a-z0-9._~+/=-]{16,}$/i.test(trimmed)) return true;
  if (/^(ghp|gho|ghu|ghs|ghr)_[a-z0-9_]{20,}$/i.test(trimmed)) return true;
  if (/^github_pat_[a-z0-9_]{20,}$/i.test(trimmed)) return true;
  if (/^sk-[a-z0-9_-]{20,}$/i.test(trimmed)) return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(trimmed)) return true;
  return false;
}

function redactInlineSecrets(value: string): string {
  return value
    .replace(/\bbearer\s+[a-z0-9._~+/=-]{16,}/gi, "Bearer [redacted]")
    .replace(
      /\b(?:gh[pousr]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,})\b/gi,
      REDACTED,
    )
    .replace(/\bsk-[a-z0-9_-]{20,}\b/gi, REDACTED)
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, REDACTED)
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, REDACTED)
    .replace(
      /\b(access_token|api_key|client_secret|password|refresh_token|secret)\s*[:=]\s*([^\s,;&]+)/gi,
      "$1=[redacted]",
    );
}

function truncateString(value: string, maxLength = MAX_STRING_LENGTH): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}...${TRUNCATED}`;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function stringLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}
