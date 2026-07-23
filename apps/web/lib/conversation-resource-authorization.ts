import { createHmac, timingSafeEqual } from "node:crypto";

import type { ConversationResourceResolution } from "@/lib/conversation-resources";

export const RESOURCE_MCP_RELAY_HEADER = "X-Comparative-Resource-Relay";
export const RESOURCE_MCP_CONTEXT_HEADER = "X-Comparative-Resource-Context";

const RESOURCE_MCP_RELAY_HMAC_MESSAGE =
  "comparative:conversation-resource-mcp-relay:v1";
// Worker turns may legitimately run for the full one-hour execution timeout.
// Keep a narrow buffer so a late tool call does not expire mid-turn.
const RESOURCE_CONTEXT_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_AUTHORIZED_RESOURCES = 5;

export interface ConversationResourceTurnContext {
  version: 1;
  userId: string;
  threadId: string;
  runId: string;
  resourceIds: string[];
  issuedAt: string;
  expiresAt: string;
}

export function resourceMcpRelayToken(): string {
  return createHmac("sha256", signingKey())
    .update(RESOURCE_MCP_RELAY_HMAC_MESSAGE)
    .digest("hex");
}

export function buildConversationResourceTurnContext({
  userId,
  threadId,
  runId,
  resolution,
  now = new Date(),
}: {
  userId: string;
  threadId: string;
  runId: string;
  resolution: ConversationResourceResolution;
  now?: Date;
}): ConversationResourceTurnContext {
  return {
    version: 1,
    userId,
    threadId,
    runId,
    resourceIds: Array.from(
      new Set(
        resolution.selected
          .map((resource) => resource.resourceId)
          .filter(Boolean),
      ),
    ).slice(0, MAX_AUTHORIZED_RESOURCES),
    issuedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + RESOURCE_CONTEXT_TTL_MS,
    ).toISOString(),
  };
}

export function signConversationResourceTurnContext(
  context: ConversationResourceTurnContext,
): string {
  const payload = Buffer.from(JSON.stringify(context)).toString("base64url");
  const signature = createHmac("sha256", signingKey())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyConversationResourceTurnContext(
  value: string | null,
  now = new Date(),
): ConversationResourceTurnContext | null {
  if (!value) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", signingKey())
    .update(payload)
    .digest("base64url");
  if (!constantTimeEqual(signature, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isConversationResourceTurnContext(parsed)) return null;
  const issuedAt = Date.parse(parsed.issuedAt);
  const expiresAt = Date.parse(parsed.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > now.getTime() + 30_000 ||
    expiresAt <= now.getTime()
  ) {
    return null;
  }
  return parsed;
}

function isConversationResourceTurnContext(
  value: unknown,
): value is ConversationResourceTurnContext {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.userId === "string" &&
    typeof value.threadId === "string" &&
    typeof value.runId === "string" &&
    typeof value.issuedAt === "string" &&
    typeof value.expiresAt === "string" &&
    Array.isArray(value.resourceIds) &&
    value.resourceIds.length > 0 &&
    value.resourceIds.length <= MAX_AUTHORIZED_RESOURCES &&
    value.resourceIds.every(
      (resourceId) =>
        typeof resourceId === "string" &&
        resourceId.length > 0 &&
        resourceId.length <= 100,
    )
  );
}

function signingKey(): string {
  const key = process.env.OAUTH_ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      "OAUTH_ENCRYPTION_KEY must be set for conversation resource signing.",
    );
  }
  return key;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
