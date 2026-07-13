import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const GOOGLE_MCP_PATH = "/api/mcp/google";
export const GOOGLE_MCP_RELAY_HEADER = "X-Comparative-MCP-Relay";
export const GOOGLE_MCP_CONTEXT_HEADER = "X-Comparative-Google-Context";

const GOOGLE_MCP_RELAY_HMAC_MESSAGE = "comparative:google-mcp-relay:v1";
const TURN_CONTEXT_TTL_MS = 5 * 60 * 1000;
const EVENT_PROPOSAL_TTL_MS = 30 * 60 * 1000;
const MAX_MAIL_CURSOR_MESSAGE_IDS = 100;
const MAX_DRAFT_AUTHORIZATION_CHARS = 8_000;

const DRAFT_AUTHORIZATION_REASONS = [
  "explicit_compose_request",
  "explicit_save_to_gmail",
  "denied_noninteractive",
  "denied_negated",
  "denied_quoted_or_embedded",
  "denied_no_directive",
  "denied_oversized",
] as const;

export type GoogleWriteTool = "create_draft" | "create_event";
export type DraftAuthorizationReason =
  (typeof DRAFT_AUTHORIZATION_REASONS)[number];

export interface DraftAuthorizationDecision {
  allowed: boolean;
  reason: DraftAuthorizationReason;
}

export interface GoogleMailSearchState {
  lastSearchedAt: string;
  previousMessageIds: string[];
}

export interface GoogleMailSearchMetadata {
  searchedAt: string;
  messageIds: string[];
}

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
  draftAuthorization?: DraftAuthorizationDecision;
  mailSearchState?: GoogleMailSearchState;
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
  const mailSearchState = buildGoogleMailSearchState(history);
  const confirmedEventProposal =
    interactive && pendingProposal && isStrictEventConfirmation(prompt)
      ? pendingProposal
      : undefined;
  const draftAuthorization = resolveDraftAuthorization(prompt, { interactive });
  const allowedWrites: GoogleWriteTool[] = [];
  if (draftAuthorization.allowed) {
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
    draftAuthorization,
    ...(mailSearchState ? { mailSearchState } : {}),
    ...(confirmedEventProposal ? { confirmedEventProposal } : {}),
  };
}

export function buildGoogleMailSearchState(
  history: readonly GoogleHistoryMessage[],
): GoogleMailSearchState | undefined {
  const searches: GoogleMailSearchMetadata[] = [];

  for (const message of history) {
    if (message.role !== "assistant") continue;
    const results = Array.isArray(message.toolResults) ? message.toolResults : [];
    for (const result of results) {
      if (!isRecord(result) || result.isError === true) continue;
      const metadata = parseGoogleMailSearchMetadata(result.output);
      if (metadata) searches.push(metadata);
    }
  }

  searches.sort(
    (left, right) => Date.parse(right.searchedAt) - Date.parse(left.searchedAt),
  );
  const latest = searches[0];
  if (!latest) return undefined;

  const previousMessageIds = new Set<string>();
  for (const search of searches) {
    for (const id of search.messageIds) {
      if (previousMessageIds.size >= MAX_MAIL_CURSOR_MESSAGE_IDS) break;
      previousMessageIds.add(id);
    }
    if (previousMessageIds.size >= MAX_MAIL_CURSOR_MESSAGE_IDS) break;
  }

  return {
    lastSearchedAt: latest.searchedAt,
    previousMessageIds: Array.from(previousMessageIds),
  };
}

export function parseGoogleMailSearchMetadata(
  value: unknown,
): GoogleMailSearchMetadata | null {
  if (!isRecord(value) || value.kind !== "google_mail_content") return null;
  const metadata = isRecord(value.searchMetadata)
    ? value.searchMetadata
    : null;
  if (!metadata || typeof metadata.searchedAt !== "string") return null;
  if (!Number.isFinite(Date.parse(metadata.searchedAt))) return null;
  if (
    !Array.isArray(metadata.messageIds) ||
    metadata.messageIds.length > MAX_MAIL_CURSOR_MESSAGE_IDS ||
    !metadata.messageIds.every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 200,
    )
  ) {
    return null;
  }
  return {
    searchedAt: metadata.searchedAt,
    messageIds: Array.from(new Set(metadata.messageIds)),
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
  return resolveDraftAuthorization(prompt, { interactive: true }).allowed;
}

export function resolveDraftAuthorization(
  prompt: string,
  { interactive }: { interactive: boolean },
): DraftAuthorizationDecision {
  if (!interactive) {
    return { allowed: false, reason: "denied_noninteractive" };
  }
  if (!prompt.trim()) {
    return { allowed: false, reason: "denied_no_directive" };
  }
  if (prompt.length > MAX_DRAFT_AUTHORIZATION_CHARS) {
    return { allowed: false, reason: "denied_oversized" };
  }

  const original = normalizeDraftAuthorizationText(prompt);
  const trusted = normalizeDraftAuthorizationText(
    stripEmbeddedAuthorizationContent(prompt),
  );
  if (isGenericDraftCapabilityQuestion(trusted)) {
    return { allowed: false, reason: "denied_no_directive" };
  }

  const matches = findDraftDirectiveMatches(trusted);
  const allowed = matches.find((match) => !isDraftDirectiveNegated(trusted, match.index));
  if (allowed) {
    return {
      allowed: true,
      reason:
        allowed.action === "save" ||
        allowed.action === "put" ||
        allowed.action === "add"
          ? "explicit_save_to_gmail"
          : "explicit_compose_request",
    };
  }
  if (matches.length > 0) {
    return { allowed: false, reason: "denied_negated" };
  }
  if (findDraftDirectiveMatches(original).length > 0) {
    return { allowed: false, reason: "denied_quoted_or_embedded" };
  }
  return { allowed: false, reason: "denied_no_directive" };
}

export function isStrictEventConfirmation(prompt: string): boolean {
  const value = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  if (value.length > 80) return false;
  return /^(yes|yes please|yep|yup|sure|ok|okay|approved|confirm|confirmed|looks good|go ahead|please do|do it|create it|create the event|schedule it|schedule the event|send the invite|send the invites)[.!]*$/.test(
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
  if (
    value.mailSearchState !== undefined &&
    !isGoogleMailSearchState(value.mailSearchState)
  ) {
    return false;
  }
  if (
    value.draftAuthorization !== undefined &&
    (!isDraftAuthorizationDecision(value.draftAuthorization) ||
      value.draftAuthorization.allowed !==
        value.allowedWrites.includes("create_draft"))
  ) {
    return false;
  }
  return (
    value.confirmedEventProposal === undefined ||
    parseGoogleEventProposal(value.confirmedEventProposal) !== null
  );
}

interface DraftDirectiveMatch {
  index: number;
  action: string;
}

function findDraftDirectiveMatches(value: string): DraftDirectiveMatch[] {
  const matches: DraftDirectiveMatch[] = [];
  const actionTarget =
    /\b(draft|compose|write|create|make|save|put|add)\b[^.!?;\n]{0,180}?\b(email|e-mail|gmail|drafts?)\b/g;
  for (const match of value.matchAll(actionTarget)) {
    matches.push({ index: match.index, action: match[1] ?? "" });
  }

  const draftRecipient = /\bdraft\b[^.!?;\n]{0,80}?\b(?:to|for)\b/g;
  for (const match of value.matchAll(draftRecipient)) {
    if (!matches.some((candidate) => candidate.index === match.index)) {
      matches.push({ index: match.index, action: "draft" });
    }
  }
  return matches.sort((left, right) => left.index - right.index);
}

function isDraftDirectiveNegated(value: string, actionIndex: number): boolean {
  const prefix = value.slice(0, actionIndex);
  const clauseBoundary = Math.max(
    prefix.lastIndexOf("."),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf("\n"),
  );
  let clausePrefix = prefix.slice(clauseBoundary + 1);
  const contrast = Array.from(
    clausePrefix.matchAll(/\b(?:but|instead|however)\b/g),
  ).at(-1);
  if (contrast?.index !== undefined) {
    clausePrefix = clausePrefix.slice(contrast.index + contrast[0].length);
  }
  if (
    /\b(?:do not|don't|dont|never|without|avoid|stop)\b[^.!?;\n]{0,80}\b(?:send|deliver)\b[^.!?;\n]{0,40}(?:,|\band\b)\s*$/.test(
      clausePrefix,
    )
  ) {
    return false;
  }
  return /\b(?:do not|don't|dont|never|no need to|without|avoid|stop)\b[^.!?;\n]{0,120}$/.test(
    clausePrefix,
  );
}

function isGenericDraftCapabilityQuestion(value: string): boolean {
  return (
    /^(?:can|could|does|do|will|would)\s+(?:comparative|it|this|the app|the tool)\s+[^.!?;\n]{0,80}\b(?:email|e-mail|gmail|drafts?)\b\s*[?.!]*$/.test(
      value,
    ) ||
    /^(?:can|could|does|do|will|would)\s+(?:you|comparative|it|this|the app|the tool)\s+(?:create|make|save|write|draft|compose)\s+(?:emails|drafts)\s*[?.!]*$/.test(
      value,
    ) ||
    /\b(?:explain|show me|tell me)\s+how\s+to\b[^.!?;\n]{0,120}\b(?:draft|compose|write|create|make|save)\b/.test(
      value,
    ) ||
    /^how\s+(?:do|can|would)\b[^.!?;\n]{0,120}\b(?:draft|compose|write|create|make|save)\b/.test(
      value,
    )
  );
}

function stripEmbeddedAuthorizationContent(value: string): string {
  return value
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/`[^`\n]*(?:`|$)/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/(^|[\s([{:\-])'[^'\n]+'(?=$|[\s)\]},.!?;:])/g, "$1 ")
    .replace(
      /(?:^|\n)\s*(?:please\s+)?(?:summarize|review|analyze|explain|translate|classify)\b[^\n]{0,160}\b(?:pasted|following|below|attached|email|message|document|file|text|note|content|paragraph)\b[^\n]{0,80}(?::\s*|\n)[\s\S]*$/gim,
      " ",
    )
    .replace(
      /\b(?:the\s+)?(?:[\w-]+\s+){0,2}(?:email|message|document|file|note|text|content|paragraph|attachment|instructions?)\s+(?:says?|reads?|contains?|includes?|asks?|instructs?)\b[^.!?;\n]*(?:[.!?;]|$)/gim,
      " ",
    );
}

function normalizeDraftAuthorizationText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function isDraftAuthorizationDecision(
  value: unknown,
): value is DraftAuthorizationDecision {
  return (
    isRecord(value) &&
    typeof value.allowed === "boolean" &&
    typeof value.reason === "string" &&
    (DRAFT_AUTHORIZATION_REASONS as readonly string[]).includes(value.reason)
  );
}

function isGoogleMailSearchState(
  value: unknown,
): value is GoogleMailSearchState {
  if (
    !isRecord(value) ||
    typeof value.lastSearchedAt !== "string" ||
    !Number.isFinite(Date.parse(value.lastSearchedAt))
  ) {
    return false;
  }
  return (
    Array.isArray(value.previousMessageIds) &&
    value.previousMessageIds.length <= MAX_MAIL_CURSOR_MESSAGE_IDS &&
    value.previousMessageIds.every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 200,
    )
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
