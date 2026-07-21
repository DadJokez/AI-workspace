import type {
  Adapter,
  AdapterAccount,
  AdapterUser,
} from "next-auth/adapters";
import {
  getDb,
  users,
  verificationTokens,
  type User as DbUser,
} from "@ai-workspace/db";
import { and, eq, lt, sql } from "drizzle-orm";
import { ensureUser } from "@/lib/users";

/**
 * Minimal NextAuth adapter over the EXISTING `users` table plus the new
 * `verification_tokens` table. Sessions stay cookie-JWT — no DB sessions.
 *
 * next-auth v4 requires an adapter for the email (magic-link) provider, and
 * once an adapter is configured the OAuth callback also routes through it
 * (`core/lib/callback-handler.js`). The methods below are exactly the set
 * those two flows invoke with JWT sessions:
 *
 *   email signin request:  getUserByEmail, createVerificationToken
 *   email link callback:   useVerificationToken, getUserByEmail,
 *                          updateUser (existing user) | createUser (new)
 *   github oauth callback: getUserByAccount, getUserByEmail, createUser,
 *                          linkAccount
 *   any callback with an existing session cookie: getUser (via JWT `sub`)
 *
 * Everything else (DB sessions, deleteUser, unlinkAccount) throws loudly so
 * an unexpected flow change fails visibly instead of corrupting user rows.
 *
 * Identity mapping: `users.ping_subject` holds the latest external subject —
 * GitHub OAuth id for GitHub sign-ins, `email:<address>` for users first
 * created via magic link (until a GitHub sign-in links and overwrites it).
 * The app's identity anchor is the email address, matching the invitation
 * system; `ensureUser` remains the single writer for user creation so
 * first-user-admin, invited-role, and invite-acceptance semantics hold for
 * every provider.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function emailPingSubject(email: string): string {
  return `email:${email.trim().toLowerCase()}`;
}

function toAdapterUser(row: DbUser): AdapterUser {
  return {
    id: row.id,
    email: row.email,
    // The users table has no email_verified column; magic-link sign-in only
    // ever completes for a verified address, and nothing in our flows reads
    // this field back.
    emailVerified: null,
    name: row.displayName,
    image: null,
  };
}

function unsupported(method: string, hint: string): Error {
  return new Error(
    `nextauth-adapter: ${method} is not implemented (${hint}). ` +
      "If a next-auth flow change starts calling this, implement it deliberately.",
  );
}

export function createNextAuthAdapter(): Adapter {
  return {
    async createUser(user: Omit<AdapterUser, "id">) {
      const email = user.email?.trim();
      if (!email) {
        throw new Error(
          "nextauth-adapter: createUser called without an email address.",
        );
      }
      // ensureUser owns creation: first-user-becomes-admin, invited-role,
      // invite acceptance + audit. For OAuth-created users linkAccount
      // immediately replaces the placeholder subject with the provider id.
      const row = await ensureUser({
        id: emailPingSubject(email),
        email,
        displayName: user.name?.trim() || email,
      });
      return toAdapterUser(row);
    },

    async getUser(id) {
      // Pre-adapter JWTs carry the GitHub account id in `sub`; only real DB
      // uuids can match a users row, so short-circuit anything else instead
      // of feeding Postgres an invalid uuid literal.
      if (!UUID_RE.test(id)) return null;
      const rows = await getDb()
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      return rows[0] ? toAdapterUser(rows[0]) : null;
    },

    async getUserByEmail(email) {
      // Case-insensitive: magic-link identifiers are lowercased by next-auth,
      // while GitHub-sourced rows store the address as the IdP returned it.
      const rows = await getDb()
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`)
        .limit(1);
      return rows[0] ? toAdapterUser(rows[0]) : null;
    },

    async getUserByAccount({ providerAccountId }) {
      const rows = await getDb()
        .select()
        .from(users)
        .where(eq(users.pingSubject, String(providerAccountId)))
        .limit(1);
      return rows[0] ? toAdapterUser(rows[0]) : null;
    },

    async updateUser(partial) {
      // The email flow calls this only to stamp emailVerified on an existing
      // user; we have no such column, so treat it as a sign-in touch.
      const rows = await getDb()
        .update(users)
        .set({ lastSeenAt: new Date() })
        .where(eq(users.id, partial.id))
        .returning();
      const row = rows[0];
      if (!row) {
        throw new Error(
          "nextauth-adapter: updateUser called for a user id with no users row.",
        );
      }
      return toAdapterUser(row);
    },

    async linkAccount(account: AdapterAccount) {
      // Single-subject model: ping_subject tracks the latest external
      // subject. Fired when an OAuth account attaches to a user that was
      // created via magic link (or via dangerous-email-linking on GitHub).
      await getDb()
        .update(users)
        .set({ pingSubject: String(account.providerAccountId) })
        .where(eq(users.id, account.userId));
    },

    async createVerificationToken(verificationToken) {
      const db = getDb();
      // Opportunistic sweep: expired never-clicked links for this address
      // would otherwise linger forever (use deletes, expiry alone does not).
      await db
        .delete(verificationTokens)
        .where(
          and(
            eq(verificationTokens.identifier, verificationToken.identifier),
            lt(verificationTokens.expires, new Date()),
          ),
        );
      await db.insert(verificationTokens).values({
        identifier: verificationToken.identifier,
        token: verificationToken.token,
        expires: verificationToken.expires,
      });
      return verificationToken;
    },

    async useVerificationToken({ identifier, token }) {
      if (!identifier || !token) return null;
      // Delete-on-read makes the token single-use; expiry is checked by
      // next-auth core against the returned `expires`.
      const rows = await getDb()
        .delete(verificationTokens)
        .where(
          and(
            eq(verificationTokens.identifier, identifier),
            eq(verificationTokens.token, token),
          ),
        )
        .returning();
      const row = rows[0];
      return row
        ? { identifier: row.identifier, token: row.token, expires: row.expires }
        : null;
    },

    async deleteUser() {
      throw unsupported("deleteUser", "user deletion is an admin concern, not next-auth's");
    },
    async unlinkAccount() {
      throw unsupported("unlinkAccount", "single ping_subject per user; nothing to unlink");
    },
    async createSession() {
      throw unsupported("createSession", "sessions are cookie-JWT, never DB rows");
    },
    async getSessionAndUser() {
      throw unsupported("getSessionAndUser", "sessions are cookie-JWT, never DB rows");
    },
    async updateSession() {
      throw unsupported("updateSession", "sessions are cookie-JWT, never DB rows");
    },
    async deleteSession() {
      throw unsupported("deleteSession", "sessions are cookie-JWT, never DB rows");
    },
  };
}
