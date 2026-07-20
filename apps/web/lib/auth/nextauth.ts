import type { NextAuthOptions } from "next-auth";
import type { EmailConfig } from "next-auth/providers/email";
import GitHubProvider from "next-auth/providers/github";
import { getDb, users, type Database } from "@ai-workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  MAGIC_LINK_MAX_AGE_SECONDS,
  sendMagicLinkEmail,
} from "@/lib/magic-link-email";
import { createNextAuthAdapter } from "@/lib/auth/nextauth-adapter";
import { ensureUser, findPendingInvitation } from "@/lib/users";

/**
 * NextAuth v4 configuration.
 *
 * Strategy notes:
 *   - JWT sessions (cookie), never DB sessions. A minimal adapter
 *     (`lib/auth/nextauth-adapter.ts`) exists because the email magic-link
 *     provider requires one; it maps onto the existing `users` table and the
 *     session strategy stays "jwt".
 *   - Providers are gated by the AUTH_PROVIDERS env allowlist (default
 *     "github,email"). Magic links are the universal tester path; GitHub
 *     OAuth is the optional secondary. "pingone" (enterprise OIDC) joins the
 *     known list when that cutover lands.
 *   - `signIn` is the security gate for BOTH providers: only allow first-ever
 *     signup, an existing user, or an email with a pending invitation. For
 *     magic links the gate runs at REQUEST time (`email.verificationRequest`)
 *     so strangers never receive a link, and again at link-click time.
 *   - The magic-link token is hashed by next-auth core (SHA-256 of
 *     token+NEXTAUTH_SECRET) before storage, expires after 15 minutes, and is
 *     single-use (adapter deletes on read).
 *   - GitHub sets `allowDangerousEmailAccountLinking` deliberately: the app's
 *     identity anchor is the (invite-gated) email address, and a user created
 *     via magic link must still be able to use the GitHub button. GitHub's
 *     returned address is the account's primary email.
 *   - Provider GitHub OAuth here is separate from the per-user GitHub
 *     MCP-token flow at /api/oauth/github/* — different scopes, purposes.
 */

const GITHUB_CLIENT_ID = process.env.GITHUB_AUTH_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_AUTH_CLIENT_SECRET;
const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET;

// Don't throw on missing GITHUB_AUTH_* at import time — that would break
// `next build` and tests. NextAuth itself surfaces a clear error from the
// route handler if the values are missing when an actual auth attempt
// happens. Silent here keeps test output uncluttered.

export const KNOWN_AUTH_PROVIDERS = ["github", "email"] as const;
export type AuthProviderId = (typeof KNOWN_AUTH_PROVIDERS)[number];

/**
 * Parse the AUTH_PROVIDERS allowlist (comma-separated). Unset/blank means the
 * default "github,email". Unknown ids are dropped with a warning so "pingone"
 * can be staged in configs before the provider exists — but an allowlist that
 * names ONLY unknown providers yields an empty list (fail closed: a typo'd
 * cutover disables sign-in visibly rather than silently re-enabling GitHub).
 */
export function parseAuthProviders(raw: string | undefined): AuthProviderId[] {
  const source = raw?.trim() ? raw : "github,email";
  const requested = source
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const unknown = requested.filter(
    (entry) => !(KNOWN_AUTH_PROVIDERS as readonly string[]).includes(entry),
  );
  if (unknown.length > 0) {
    console.warn(
      `AUTH_PROVIDERS contains unknown provider(s) ignored: ${unknown.join(", ")}`,
    );
  }
  return KNOWN_AUTH_PROVIDERS.filter((id) => requested.includes(id));
}

const enabledProviders = parseAuthProviders(process.env.AUTH_PROVIDERS);

/** Provider ids enabled for this deployment — drives the login page UI. */
export function enabledAuthProviders(): AuthProviderId[] {
  return [...enabledProviders];
}

/**
 * Rate limit for magic-link requests, keyed per email+IP by the
 * [...nextauth] route wrapper. Mirrors `inviteEmailRateLimit`
 * (lib/admin-invitations.ts) and runs through the same
 * `checkRateLimit` Postgres buckets.
 */
export const magicLinkRateLimit = {
  maxRequestBytes: 8 * 1024,
  maxMessageChars: 512,
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
};

export function magicLinkRateLimitKey(
  email: string,
  xForwardedFor: string | null,
): string {
  const ip = (xForwardedFor ?? "").split(",")[0]!.trim() || "unknown";
  return `magic-link:${email.trim().toLowerCase()}:${ip}`;
}

/**
 * The email provider config is hand-rolled (not `EmailProvider(...)`) because
 * `next-auth/providers/email` requires nodemailer at module load and we send
 * through the SES SigV4 core instead — no nodemailer, no SDK dependency.
 * next-auth only needs this object's shape; `server`/`from` feed the default
 * nodemailer transport we never use.
 */
function magicLinkProvider(): EmailConfig {
  return {
    id: "email",
    type: "email",
    name: "Email",
    server: {},
    from: process.env.INVITE_EMAIL_FROM ?? "",
    maxAge: MAGIC_LINK_MAX_AGE_SECONDS,
    options: {},
    async sendVerificationRequest({ identifier, url, expires }) {
      await sendMagicLinkEmail({ to: identifier, url, expires });
    },
  };
}

/**
 * Shared invite gate: an email may sign in when it belongs to an existing
 * user, when the users table is empty (first-signer bootstrap, same rule as
 * GitHub), or when it holds a pending unexpired invitation. Used by the
 * GitHub path (after its own by-subject match) and by both phases of the
 * magic-link flow.
 */
async function emailAllowedToSignIn(
  db: Database,
  email: string,
): Promise<boolean> {
  const address = email.trim().toLowerCase();
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${address}`)
    .limit(1);
  if (existing[0]) return true;

  const counts = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);
  if ((counts[0]?.count ?? 0) === 0) return true;

  const invite = await findPendingInvitation(address);
  return invite != null;
}

function buildProviders(): NextAuthOptions["providers"] {
  const providers: NextAuthOptions["providers"] = [];
  if (enabledProviders.includes("github")) {
    providers.push(
      GitHubProvider({
        clientId: GITHUB_CLIENT_ID ?? "",
        clientSecret: GITHUB_CLIENT_SECRET ?? "",
        // `read:user user:email` is the default scope; it's enough for us to
        // read the GitHub `id`, `name`, and primary verified `email`.
        //
        // Deliberate: with the adapter present, a user first created via
        // magic link (ping_subject = email:<addr>) has no GitHub account row
        // to match, so next-auth must be allowed to attach the GitHub
        // identity by email — otherwise the GitHub button breaks for every
        // magic-link-first tester with OAuthAccountNotLinked. The invite
        // gate in `signIn` still applies.
        allowDangerousEmailAccountLinking: true,
      }),
    );
  }
  if (enabledProviders.includes("email")) {
    providers.push(magicLinkProvider());
  }
  return providers;
}

export const authOptions: NextAuthOptions = {
  providers: buildProviders(),
  // Required by the email provider; also puts GitHub OAuth on the adapter
  // path (attached unconditionally so behavior never depends on which
  // allowlist combination is active). Sessions remain JWT regardless.
  adapter: createNextAuthAdapter(),
  session: { strategy: "jwt" },
  secret: NEXTAUTH_SECRET,
  pages: {
    // Replace NextAuth's default sign-in / error pages with our own /login.
    // Errors land back here as `?error=AccessDenied` etc, surfaced inline.
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    /**
     * Gate sign-up. Allow when:
     *   1. The `users` table is empty — first signer becomes admin.
     *   2. A user row already exists for this identity (GitHub subject or
     *      email address).
     *   3. There's a pending, unexpired invitation for this email.
     * Otherwise: deny.
     *
     * For the email provider this runs TWICE: at link-request time
     * (`email.verificationRequest === true` — deny means the stranger never
     * receives a link; the login page shows the same neutral "if that address
     * is invited, a link is on its way" copy either way, so denial is not an
     * account-existence oracle) and again at link-click time (`email`
     * undefined — covers invites revoked between request and click).
     */
    async signIn({ account, profile, user, email }) {
      const db = getDb();

      if (account?.provider === "email") {
        const address = (user?.email ?? String(account.providerAccountId))
          ?.trim()
          .toLowerCase();
        if (!address) return false;
        // Same gate for the request phase (email.verificationRequest) and
        // the callback phase — the callback's token validity/single-use is
        // already enforced by next-auth core + the adapter by this point.
        void email;
        return emailAllowedToSignIn(db, address);
      }

      if (account?.provider === "github") {
        const ghSub = String(account.providerAccountId);
        const ghEmail =
          (profile as { email?: string | null } | undefined)?.email ??
          user.email ??
          null;
        if (!ghEmail) return false;

        const existing = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.pingSubject, ghSub))
          .limit(1);
        if (existing[0]) return true;

        return emailAllowedToSignIn(db, ghEmail);
      }

      return false;
    },

    /**
     * Stamp our DB-side claims onto the JWT.
     *
     * Sign-in (`account` present):
     *   - email provider: the adapter flow has already resolved/created the
     *     users row — `user.id` is our DB uuid; re-read it for the role.
     *   - github: run `ensureUser` keyed by the GitHub subject, exactly as
     *     before the adapter existed.
     * Refresh (no `account`): re-read by `ghSub` (GitHub-originated tokens)
     * or by `userId` (magic-link-originated tokens) so role changes take
     * effect without a fresh sign-in.
     */
    async jwt({ token, account, profile, user }) {
      if (account?.provider === "email") {
        const row = user?.id ? await findUserById(user.id) : null;
        if (row) {
          token.userId = row.id;
          token.role = row.role;
          token.email = row.email;
          token.name = row.displayName;
        }
        return token;
      }

      const ghSub = account
        ? String(account.providerAccountId)
        : (token.ghSub as string | undefined);

      if (!ghSub && token.userId) {
        // Magic-link session refresh: no external subject on the token.
        const row = await findUserById(token.userId);
        if (row) {
          token.role = row.role;
          token.email = row.email;
          token.name = row.displayName;
        }
        return token;
      }

      const email =
        (profile as { email?: string | null } | undefined)?.email ??
        user?.email ??
        (token.email as string | undefined) ??
        null;
      const displayName =
        (profile as { name?: string | null } | undefined)?.name ??
        user?.name ??
        (token.name as string | undefined) ??
        email ??
        null;
      if (!ghSub || !email || !displayName) return token;

      const dbUser = await ensureUser({
        id: ghSub,
        email,
        displayName,
      });

      token.ghSub = ghSub;
      token.userId = dbUser.id;
      token.role = dbUser.role;
      token.email = dbUser.email;
      token.name = dbUser.displayName;
      return token;
    },

    /**
     * Hydrate `session.user` with the shape the rest of the app expects
     * (`SessionUser` from `@ai-workspace/auth`). Type augmentation lives in
     * `apps/web/types/next-auth.d.ts`.
     */
    async session({ session, token }) {
      if (session.user && token.userId) {
        session.user.id = token.userId as string;
        session.user.role = (token.role as "admin" | "user") ?? "user";
        session.user.email = (token.email as string) ?? session.user.email;
        session.user.displayName =
          (token.name as string) ?? session.user.name ?? "";
      }
      return session;
    },
  },
};

async function findUserById(id: string) {
  const rows = await getDb()
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return rows[0] ?? null;
}
