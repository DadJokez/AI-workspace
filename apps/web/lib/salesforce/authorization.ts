import { createHmac, timingSafeEqual } from "node:crypto";

export const SALESFORCE_MCP_PATH = "/api/mcp/salesforce";
export const SALESFORCE_MCP_RELAY_HEADER = "X-Comparative-MCP-Relay";
export const SALESFORCE_MCP_CONTEXT_HEADER = "X-Comparative-Salesforce-Context";

const SALESFORCE_MCP_RELAY_HMAC_MESSAGE = "comparative:salesforce-mcp-relay:v1";
const TURN_CONTEXT_TTL_MS = 5 * 60 * 1000;

/**
 * Read-only turn context: binds the facade call to the requesting user and
 * their verified Salesforce instance host so neither can be substituted
 * between mount time and tool execution. No write authorization exists in v1
 * by design (#358).
 */
export interface SalesforceTurnContext {
  userId: string;
  instanceUrl: string;
  issuedAt: string;
}

export function buildSalesforceTurnContext({
  userId,
  instanceUrl,
  now = new Date(),
}: {
  userId: string;
  instanceUrl: string;
  now?: Date;
}): SalesforceTurnContext {
  return { userId, instanceUrl, issuedAt: now.toISOString() };
}

export function salesforceMcpRelayToken(): string {
  return createHmac("sha256", signingKey())
    .update(SALESFORCE_MCP_RELAY_HMAC_MESSAGE)
    .digest("hex");
}

export function signSalesforceTurnContext(
  context: SalesforceTurnContext,
): string {
  const payload = Buffer.from(JSON.stringify(context)).toString("base64url");
  const signature = createHmac("sha256", signingKey())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function verifySalesforceTurnContext(
  value: string | null,
  now: Date = new Date(),
): SalesforceTurnContext | null {
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
  if (typeof parsed !== "object" || parsed === null) return null;
  const context = parsed as Record<string, unknown>;
  if (
    typeof context.userId !== "string" ||
    typeof context.instanceUrl !== "string" ||
    typeof context.issuedAt !== "string"
  ) {
    return null;
  }
  const issuedAt = new Date(context.issuedAt);
  if (Number.isNaN(issuedAt.getTime())) return null;
  if (now.getTime() - issuedAt.getTime() > TURN_CONTEXT_TTL_MS) return null;
  if (issuedAt.getTime() - now.getTime() > 60_000) return null;
  return {
    userId: context.userId,
    instanceUrl: context.instanceUrl,
    issuedAt: context.issuedAt,
  };
}

function signingKey(): string {
  const key = process.env.OAUTH_ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      "OAUTH_ENCRYPTION_KEY must be set for Salesforce tool signing.",
    );
  }
  return key;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
