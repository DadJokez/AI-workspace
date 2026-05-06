import { PUBLIC_BASE_URL } from "@/lib/oauth/github";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Email regex used by both the API route (validation) and tests. Intentionally
 * permissive — we just want to reject obviously broken input. Real deliverability
 * is out of scope; the IdP will catch nonexistent emails on sign-in.
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function buildInviteUrl(token: string): string {
  return `${PUBLIC_BASE_URL}/invite/${token}`;
}

/**
 * Public shape returned by the admin invitations API and consumed by the
 * /admin UI. Lives here (and not in the route file) so server components can
 * import it without pulling the HTTP handler module.
 */
export interface AdminInvitationRow {
  id: string;
  email: string;
  role: "admin" | "user";
  invitedBy: string;
  invitedByEmail: string | null;
  expiresAt: string;
  createdAt: string;
  inviteUrl: string;
}

export type InviteLookup =
  | { kind: "valid"; email: string; role: "admin" | "user" }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "used" };

interface LookupRow {
  acceptedAt: Date | null;
  expiresAt: Date;
  email: string;
  role: "admin" | "user";
}

/**
 * Decide which of the four /invite/[token] outcomes a given DB row represents.
 * Pure so the page can stay a thin wrapper around a DB read, and so tests can
 * exercise every branch without a Postgres dependency.
 */
export function classifyInvitation(
  row: LookupRow | undefined,
  now: Date = new Date(),
): InviteLookup {
  if (!row) return { kind: "not_found" };
  if (row.acceptedAt) return { kind: "used" };
  if (row.expiresAt.getTime() <= now.getTime()) return { kind: "expired" };
  return { kind: "valid", email: row.email, role: row.role };
}
