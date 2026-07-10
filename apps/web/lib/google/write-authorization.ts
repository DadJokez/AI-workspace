import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const GOOGLE_MCP_PATH = "/api/mcp/google";
export const GOOGLE_MCP_RELAY_HEADER = "X-Comparative-MCP-Relay";
export const GOOGLE_MCP_CONTEXT_HEADER = "X-Comparative-Google-Context";

const GOOGLE_MCP_RELAY_HMAC_MESSAGE = "comparative:google-mcp-relay:v1";
const TURN_CONTEXT_TTL_MS = 5 * 60 * 1000;
const EVENT_PROPOSAL_TTL_MS = 30 * 60 * 1000;

export type GoogleWriteTool = "create_draft" | "create_event";

export interface GoogleEventProposal {
  kind: "google_calendar_event_proposal";
  proposalId: string;
  issuedRunId: string;
  issuedAt: string;
  expiresAt: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  timeZone: string;
  attendees: string[];
  location?: string;
  description?: string;
  remindersMinutes?: number[];
  sendInvitations: boolean;
}

export interface GoogleTurnContext {
  version: 1;
  userId: string;
  threadId: string;
  runId: string;
  issuedAt: string;
  expiresAt: string;
  allowedWrites: GoogleWriteTool[];
  confirmedEventProposal?: GoogleEventProposal;
}

export interface GoogleHistoryMessage {
  role: string;
  toolResults?: unknown;
}

export function googleMcpRelayToken(): string {
  return createHmac("sha256", signingKey())
    .update(GOOGLE_MCP_RELAY_HMAC_MESSAGE)
    .digest("hex");
}

export function createGoogleTurnContextHeader({
  userId,
  threadId,
  runId,
  prompt,
  history,
  interactive,
  now = new Date(),
}: {
  userId: string;
  threadId: string;
  runId: string;
  prompt: string;
  history: readonly GoogleHistoryMessage[];
  interactive: boolean;
  now?: Date;
}): string {
  return signGoogleTurnContext(
    buildGoogleTurnContext({
      userId,
      threadId,
      runId,
      prompt,
      history,
      interactive,
      now,
    }),
  );
}

export function buildGoogleTurnContext({
  userId,
  threadId,
  runId,
  prompt,
  history,
  interactive,
  now = new Date(),
}: {
  userId: string;
  threadId: string;
  runId: string;
  prompt: string;
  history: readonly GoogleHistoryMessage[];
  interactive: boolean;
  now?: Date;
}): GoogleTurnContext {
  const pendingProposal = findLatestGoogleEventProposal(history, now);
  const confirmedEventProposal =
    interactive && pendingProposal && isStrictEventConfirmation(prompt)
      ? pendingProposal
      : undefined;
  const allowedWrites: GoogleWriteTool[] = [];
  if (interactive && hasExplicitDraftIntent(prompt)) {
    allowedWrites.push("create_draft");
  }
  if (confirmedEventProposal) allowedWrites.push("create_event");

  return {
    version: 1,
    userId,
    threadId,
    runId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TURN_CONTEXT_TTL_MS).toISOString(),
    allowedWrites,
    ...(confirmedEventProposal ? { confirmedEventProposal } : {}),
  };
}

export function signGoogleTurnContext(context: GoogleTurnContext): string {
  const payload = Buffer.from(JSON.stringify(context)).toString("base64url");
  const signature = createHmac("sha256", signingKey())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyGoogleTurnContext(
  value: string | null,
  now: Date = new Date(),
): GoogleTurnContext | null {
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
  if (!isGoogleTurnContext(parsed)) return null;
  const expiresAt = Date.parse(parsed.expiresAt);
  const issuedAt = Date.parse(parsed.issuedAt);
  if (
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(issuedAt) ||
    expiresAt <= now.getTime() ||
    issuedAt > now.getTime() + 30_000
  ) {
    return null;
  }
  return parsed;
}

export function createGoogleEventProposal(
  input: Omit<
    GoogleEventProposal,
    "kind" | "proposalId" | "issuedRunId" | "issuedAt" | "expiresAt"
  >,
  context: GoogleTurnContext,
  now: Date = new Date(),
): GoogleEventProposal {
  return {
    kind: "google_calendar_event_proposal",
    proposalId: randomUUID(),
    issuedRunId: context.runId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + EVENT_PROPOSAL_TTL_MS).toISOString(),
    ...input,
  };
}

export function findLatestGoogleEventProposal(
  messages: readonly GoogleHistoryMessage[],
  now: Date = new Date(),
): GoogleEventProposal | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const results = Array.isArray(message.toolResults) ? message.toolResults : [];
    for (let resultIndex = results.length - 1; resultIndex >= 0; resultIndex -= 1) {
      const result = results[resultIndex];
      const output = isRecord(result) ? result.output : undefined;
      const proposal = parseGoogleEventProposal(output);
      if (proposal && Date.parse(proposal.expiresAt) > now.getTime()) {
        return proposal;
      }
    }
    return null;
  }
  return null;
}

export function parseGoogleEventProposal(
  value: unknown,
): GoogleEventProposal | null {
  if (!isRecord(value) || value.kind !== "google_calendar_event_proposal") {
    return null;
  }
  const requiredStrings = [
    "proposalId",
    "issuedRunId",
    "issuedAt",
    "expiresAt",
    "calendarId",
    "title",
    "start",
    "end",
    "timeZone",
  ] as const;
  if (requiredStrings.some((key) => typeof value[key] !== "string")) {
    return null;
  }
  if (
    !Array.isArray(value.attendees) ||
    !value.attendees.every((attendee) => typeof attendee === "string") ||
    typeof value.sendInvitations !== "boolean"
  ) {
    return null;
  }
  if (
    value.remindersMinutes !== undefined &&
    (!Array.isArray(value.remindersMinutes) ||
      !value.remindersMinutes.every((minute) => Number.isInteger(minute)))
  ) {
    return null;
  }
  return value as unknown as GoogleEventProposal;
}

export function hasExplicitDraftIntent(prompt: string): boolean {
  const value = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  if (!value || value.length > 1_000) return false;
  if (/^(?:do not|don't|dont|never|without)\b/.test(value)) return false;

  const directRequest =
    /^(?:please\s+)?(?:draft|compose|write|create|make|save)\b.{0,120}\b(?:email|e-mail|message|draft)\b/.test(
      value,
    ) || /^(?:please\s+)?draft\b.{0,80}\b(?:to|for)\b/.test(value);
  const politeRequest =
    /^(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:draft|compose|write|create|make|save)\b.{0,120}\b(?:email|e-mail|message|draft)\b/.test(
      value,
    );
  const statedNeed =
    /^i\s+(?:want|need|would like)\s+(?:you\s+to\s+)?(?:draft|compose|write|create|make|save|an?\s+(?:email\s+)?draft)\b/.test(
      value,
    );
  return directRequest || politeRequest || statedNeed;
}

export function isStrictEventConfirmation(prompt: string): boolean {
  const value = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  if (value.length > 80) return false;
  return /^(yes|yes please|confirm|confirmed|looks good|go ahead|do it|create it|create the event|schedule it|schedule the event|send the invite|send the invites)[.!]*$/.test(
    value,
  );
}

function isGoogleTurnContext(value: unknown): value is GoogleTurnContext {
  if (!isRecord(value) || value.version !== 1) return false;
  if (
    typeof value.userId !== "string" ||
    typeof value.threadId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.issuedAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    !Array.isArray(value.allowedWrites) ||
    !value.allowedWrites.every(
      (tool) => tool === "create_draft" || tool === "create_event",
    )
  ) {
    return false;
  }
  return (
    value.confirmedEventProposal === undefined ||
    parseGoogleEventProposal(value.confirmedEventProposal) !== null
  );
}

function signingKey(): string {
  const key = process.env.OAUTH_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("OAUTH_ENCRYPTION_KEY must be set for Google tool signing.");
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
