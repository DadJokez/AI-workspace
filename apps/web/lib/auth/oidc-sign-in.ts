import type { UserRole } from "@ai-workspace/auth";
import {
  userGroups,
  users,
  type Database,
  type User as DbUser,
} from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import type { AuthDenialReason } from "@/lib/auth/auth-audit";
import { emailPingSubject } from "@/lib/auth/nextauth-adapter";
import {
  isOidcGroupName,
  OIDC_SUBJECT_PREFIX,
  type OidcConfig,
} from "@/lib/deployment-config";

/**
 * OIDC sign-in: what the identity provider's claims mean for a `users` row.
 *
 * Claims are untrusted input. Every value is type- and size-checked here
 * before anything else reads it, and nothing from a claim is logged.
 *
 * Identity. A user is matched on `ping_subject = "pingone:<sub>"` and on
 * nothing else. Two people who present the same address with different
 * subjects are two users. The one exception is adoption, below.
 *
 * Access. With OIDC_REQUIRED_GROUP set, the groups claim must be readable and
 * contain it. Invitations are not consulted: the identity provider decides.
 *
 * Role. With OIDC_ADMIN_GROUP set, the role is recomputed from the groups
 * claim on every sign-in and written over whatever the row held: in the group
 * is `admin`, anything else (not in it, no claim, an unreadable claim) is
 * `user`. An admin removed from the group is therefore demoted at their next
 * sign-in, not before. Without OIDC_ADMIN_GROUP a sign-in never changes a
 * role and a new user starts as `user`.
 */

/** OIDC Core caps `sub` at 255 characters. */
const SUBJECT_MAX_CHARS = 255;
const EMAIL_MAX_CHARS = 320;
const DISPLAY_NAME_MAX_CHARS = 200;
/** More entries than this is treated as an unreadable claim, not truncated. */
export const OIDC_MAX_GROUPS = 1000;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface OidcIdentity {
  /** `pingone:<sub>`: the value stored in `users.ping_subject`. */
  subject: string;
  /** Lower-cased. */
  email: string;
  /** True only for a literal `email_verified: true`. */
  emailVerified: boolean;
  displayName: string;
  /** Null when the claim is absent or is not a list of group names. */
  groups: string[] | null;
}

export type OidcClaimsResult =
  | { ok: true; identity: OidcIdentity }
  | { ok: false; reason: Extract<AuthDenialReason, "invalid_subject" | "missing_email"> };

/** The `ping_subject` value for an OIDC `sub`. */
export function oidcPingSubject(sub: string): string {
  return `${OIDC_SUBJECT_PREFIX}${sub}`;
}

/**
 * A groups claim is a list of group names. A bare string is read as a list of
 * one, because some identity providers send a single-valued attribute that
 * way. Anything else, including a list with one bad entry, is unreadable:
 * a partly-read list could hide the absence of a required group.
 */
function readGroups(value: unknown): string[] | null {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.length > OIDC_MAX_GROUPS) return null;
  const names: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || !isOidcGroupName(entry)) return null;
    names.push(entry);
  }
  return [...new Set(names)];
}

/** Validate the raw claim set from the ID token (and userinfo, for groups). */
export function readOidcClaims(
  claims: unknown,
  oidc: Pick<OidcConfig, "groupsClaim">,
): OidcClaimsResult {
  const record =
    claims !== null && typeof claims === "object"
      ? (claims as Record<string, unknown>)
      : {};
  const own = (name: string) =>
    Object.hasOwn(record, name) ? record[name] : undefined;

  const sub = own("sub");
  if (
    typeof sub !== "string" ||
    sub.length === 0 ||
    sub.length > SUBJECT_MAX_CHARS ||
    sub !== sub.replace(CONTROL_CHARACTERS, "")
  ) {
    return { ok: false, reason: "invalid_subject" };
  }

  const rawEmail = own("email");
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!email || email.length > EMAIL_MAX_CHARS || !EMAIL_SHAPE.test(email)) {
    return { ok: false, reason: "missing_email" };
  }

  const rawName = own("name");
  const name =
    typeof rawName === "string"
      ? rawName
          .replace(CONTROL_CHARACTERS, " ")
          .trim()
          .slice(0, DISPLAY_NAME_MAX_CHARS)
      : "";

  return {
    ok: true,
    identity: {
      subject: oidcPingSubject(sub),
      email,
      emailVerified: own("email_verified") === true,
      displayName: name || email,
      groups: readGroups(own(oidc.groupsClaim)),
    },
  };
}

/** Why this identity may not sign in, or null when it may. Fails closed. */
export function oidcAccessDenial(
  identity: Pick<OidcIdentity, "groups">,
  oidc: Pick<OidcConfig, "requiredGroup">,
): Extract<
  AuthDenialReason,
  "groups_claim_unreadable" | "required_group_missing"
> | null {
  if (!oidc.requiredGroup) return null;
  if (identity.groups === null) return "groups_claim_unreadable";
  return identity.groups.includes(oidc.requiredGroup)
    ? null
    : "required_group_missing";
}

/**
 * The role the claim dictates, or null when OIDC_ADMIN_GROUP is unset and the
 * stored role stands. A missing or unreadable claim is never `admin`.
 */
export function oidcRole(
  identity: Pick<OidcIdentity, "groups">,
  oidc: Pick<OidcConfig, "adminGroup">,
): UserRole | null {
  if (!oidc.adminGroup) return null;
  return identity.groups?.includes(oidc.adminGroup) ? "admin" : "user";
}

export interface OidcProvisionResult {
  user: DbUser;
  created: boolean;
  /** True when an existing magic-link user was re-keyed to this subject. */
  adopted: boolean;
  /** Set when this sign-in changed the stored role. */
  roleChange: { from: UserRole; to: UserRole } | null;
}

/**
 * Find or create the user for an identity that passed the access gate, apply
 * the role the claim dictates, and replace the stored group names. One
 * transaction: a failure leaves the row, its role and its groups as they were.
 *
 * Adoption (OIDC_ADOPT_EMAIL_USERS=1, off by default) is the only path that
 * links by address. It needs all of: no user yet for this subject, the
 * identity provider asserting `email_verified: true`, and a user whose subject
 * is exactly `email:<this address>`, that is, one who has only ever signed in
 * by magic link. That row is re-keyed to the OIDC subject and keeps its data.
 * A user who has since linked GitHub is not adopted, and an unverified address
 * never adopts anyone: either gets a fresh, separate user.
 */
export async function provisionOidcUser(
  db: Database,
  identity: OidcIdentity,
  oidc: Pick<OidcConfig, "adminGroup" | "adoptEmailUsers">,
): Promise<OidcProvisionResult> {
  return db.transaction(async (tx) => {
    let created = false;
    let adopted = false;

    let row = (
      await tx
        .select()
        .from(users)
        .where(eq(users.pingSubject, identity.subject))
        .limit(1)
        .for("update")
    )[0];

    if (!row && oidc.adoptEmailUsers && identity.emailVerified) {
      // `ping_subject` is unique, so this matches at most one row.
      row = (
        await tx
          .update(users)
          .set({ pingSubject: identity.subject })
          .where(eq(users.pingSubject, emailPingSubject(identity.email)))
          .returning()
      )[0];
      adopted = row !== undefined;
    }

    if (!row) {
      // Two first sign-ins for one subject can race; the loser reads the
      // winner's row instead of failing on the unique index.
      row = (
        await tx
          .insert(users)
          .values({
            pingSubject: identity.subject,
            email: identity.email,
            displayName: identity.displayName,
            role: "user",
          })
          .onConflictDoNothing({ target: users.pingSubject })
          .returning()
      )[0];
      created = row !== undefined;
      row ??= (
        await tx
          .select()
          .from(users)
          .where(eq(users.pingSubject, identity.subject))
          .limit(1)
      )[0]!;
    }

    const userId = row.id;
    const role = oidcRole(identity, oidc) ?? row.role;
    const roleChange =
      role === row.role ? null : { from: row.role, to: role };
    // The identity provider owns the address; the display name stays the
    // user's own once the row exists (same rule as `ensureUser`).
    const updated = (
      await tx
        .update(users)
        .set({ email: identity.email, role, lastSeenAt: new Date() })
        .where(eq(users.id, userId))
        .returning()
    )[0]!;

    await tx.delete(userGroups).where(eq(userGroups.userId, userId));
    if (identity.groups && identity.groups.length > 0) {
      await tx.insert(userGroups).values(
        identity.groups.map((groupName) => ({
          userId,
          groupName,
        })),
      );
    }

    return { user: updated, created, adopted, roleChange };
  });
}
