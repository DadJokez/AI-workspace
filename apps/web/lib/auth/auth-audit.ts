import { auditLog, getDb, type Database } from "@ai-workspace/db";

/**
 * Authentication events in the central audit ledger.
 *
 * The ledger already records ~60 application action types but recorded no
 * authentication at all, which is the first thing an access-review or SOC2
 * auditor asks for: who signed in, who was turned away, who signed out.
 * These rows reuse the existing `audit_log` shape — no migration.
 *
 * What is deliberately NOT stored: the JWT/session token, OAuth access or id
 * tokens, magic-link tokens, or anything else from `account`. The only
 * identity written is the DB user id (successful sign-in / sign-out) or the
 * attempted address for a denial, which is the same class of data the
 * invitation events already store in `input.email`.
 */

export const AUTH_AUDIT_SCHEMA = "auth-event.v1";
export const AUTH_AUDIT_PROVIDER = "ai-hub";
export const AUTH_AUDIT_TOOL = "auth";

/** Longest user-agent string kept; anything past this is noise. */
export const AUTH_AUDIT_USER_AGENT_MAX = 256;

export type AuthAuditAction =
  | "auth_sign_in"
  | "auth_sign_in_denied"
  | "auth_sign_out";

/** Why a sign-in was refused. Never free-form text from the caller. */
export type AuthDenialReason =
  | "not_invited"
  | "missing_email"
  | "unsupported_provider";

/**
 * Magic links run the gate twice: once when the link is requested (before any
 * mail is sent) and once when it is clicked. Which phase denied matters when
 * reading the ledger back.
 */
export type AuthSignInPhase = "link_request" | "callback";

export interface AuthRequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface AuthAuditEvent {
  action: AuthAuditAction;
  /** DB user id; null for denials and for tokens that predate `userId`. */
  actorUserId?: string | null;
  /** NextAuth provider id ("github" | "email"), not a credential. */
  authProvider?: string | null;
  /** Attempted address — denials only, so the row identifies the subject. */
  email?: string | null;
  reason?: AuthDenialReason;
  phase?: AuthSignInPhase;
  isNewUser?: boolean;
  request?: AuthRequestContext | null;
}

export interface AuthAuditRow {
  actorUserId: string | null;
  actionType: AuthAuditAction;
  status: "succeeded" | "denied";
  provider: typeof AUTH_AUDIT_PROVIDER;
  toolName: typeof AUTH_AUDIT_TOOL;
  input: { email: string } | null;
  error: string | null;
  metadata: {
    schema: typeof AUTH_AUDIT_SCHEMA;
    authProvider?: string;
    phase?: AuthSignInPhase;
    isNewUser?: boolean;
    ip?: string;
    userAgent?: string;
  };
}

/**
 * The RIGHTMOST x-forwarded-for entry — the hop our own ALB appended. Clients
 * can prepend arbitrary values, so the leftmost entry is attacker-controlled;
 * same rule the magic-link rate limiter uses (see `magicLinkRateLimitKey`).
 */
export function clientIpFromForwardedFor(
  xForwardedFor: string | null | undefined,
): string | null {
  const hops = (xForwardedFor ?? "").split(",");
  return hops[hops.length - 1]!.trim() || null;
}

export function authRequestContextFrom(headers: Headers): AuthRequestContext {
  const userAgent = headers.get("user-agent")?.trim();
  return {
    ip: clientIpFromForwardedFor(headers.get("x-forwarded-for")),
    userAgent: userAgent
      ? userAgent.slice(0, AUTH_AUDIT_USER_AGENT_MAX)
      : null,
  };
}

/**
 * Best-effort request context for an auth event. NextAuth v4 hands neither
 * `callbacks` nor `events` the request, but both run inside the App Router
 * request scope, so `next/headers` still resolves. The import is dynamic and
 * the whole thing is guarded: outside a request (unit tests, scripts) this
 * returns nulls rather than throwing into the sign-in path.
 */
export async function authRequestContext(): Promise<AuthRequestContext> {
  try {
    const { headers } = await import("next/headers");
    return authRequestContextFrom(await headers());
  } catch {
    return { ip: null, userAgent: null };
  }
}

export function buildAuthAuditRow(event: AuthAuditEvent): AuthAuditRow {
  const email = event.email?.trim().toLowerCase();
  return {
    actorUserId: event.actorUserId ?? null,
    actionType: event.action,
    status: event.action === "auth_sign_in_denied" ? "denied" : "succeeded",
    provider: AUTH_AUDIT_PROVIDER,
    toolName: AUTH_AUDIT_TOOL,
    input: email ? { email } : null,
    error: event.reason ?? null,
    metadata: {
      schema: AUTH_AUDIT_SCHEMA,
      ...(event.authProvider ? { authProvider: event.authProvider } : {}),
      ...(event.phase ? { phase: event.phase } : {}),
      ...(typeof event.isNewUser === "boolean"
        ? { isNewUser: event.isNewUser }
        : {}),
      ...(event.request?.ip ? { ip: event.request.ip } : {}),
      ...(event.request?.userAgent
        ? { userAgent: event.request.userAgent }
        : {}),
    },
  };
}

/**
 * Append one auth event. Fails OPEN: the ledger going down must not lock
 * everyone out of sign-in, so a failed write is logged (message only — never
 * the driver's error object, which can echo row values) and swallowed.
 */
export async function recordAuthEvent(
  event: AuthAuditEvent,
  db: Database = getDb(),
): Promise<void> {
  try {
    await db.insert(auditLog).values(buildAuthAuditRow(event));
  } catch (error) {
    console.error(
      `[auth-audit] failed to record ${event.action}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}
