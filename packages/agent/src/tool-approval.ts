import type {
  McpToolExecutionIdentity,
  ToolApprovalGrant,
  ToolApprovalRequest,
  ToolCall,
} from "./types";

const FINGERPRINT_SCHEMA = "comparative.tool-call-fingerprint.v1";

export async function buildToolApprovalRequest({
  call,
  identity,
}: {
  call: ToolCall;
  identity?: McpToolExecutionIdentity;
}): Promise<ToolApprovalRequest> {
  return {
    schema: "comparative.tool-approval-request.v1",
    toolCallId: call.id,
    toolName: call.name,
    ...(identity ? { identity } : {}),
    fingerprint: await toolCallFingerprint({
      toolName: call.name,
      identity,
      input: call.input,
    }),
  };
}

export async function toolCallFingerprint({
  toolName,
  identity,
  input,
}: {
  toolName: string;
  identity?: McpToolExecutionIdentity;
  input: unknown;
}): Promise<string> {
  const bytes = new TextEncoder().encode(
    stableJson({
      schema: FINGERPRINT_SCHEMA,
      toolName,
      identity: identity ?? null,
      input,
    }),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function matchingToolApprovalGrant({
  request,
  grants,
  consumedApprovalIds,
}: {
  request: ToolApprovalRequest;
  grants: readonly ToolApprovalGrant[];
  consumedApprovalIds: ReadonlySet<string>;
}): ToolApprovalGrant | undefined {
  return grants.find(
    (grant) =>
      grant.toolCallId === request.toolCallId &&
      grant.fingerprint === request.fingerprint &&
      !consumedApprovalIds.has(grant.approvalId),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, canonicalize(source[key])]),
    );
  }
  return null;
}
