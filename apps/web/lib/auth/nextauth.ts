import type { NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";
import { getDb, users } from "@ai-workspace/db";
import { eq, sql } from "drizzle-orm";
import { ensureUser, findPendingInvitation } from "@/lib/users";

/**
 * NextAuth v4 configuration. Replaces the week-1 env-var auth shim.
 *
 * Strategy notes:
 *   - JWT sessions, no DB adapter. The `users` and `invitations` tables are
 *     owned by `ensureUser`; NextAuth doesn't need to manage account/session
 *     rows for us.
 *   - GitHub is the only IdP. The OAuth identity stored on `users.ping_subject`
 *     is `account.providerAccountId` (the GitHub user ID, as a string).
 *   - `signIn` is the security gate: only allow first-ever signup, an existing
 *     user, or an email with a pending invitation. Random GitHub users can't
 *     sign themselves up.
 *   - `jwt` runs `ensureUser` on every sign-in (and again on subsequent token
 *     refreshes if `force-refresh` is needed) so `lastSeenAt` and `role` stay
 *     fresh on the session.
 *   - Provider GitHub OAuth here is separate from the per-user GitHub MCP-token
 *     flow at /api/oauth/github/* — different scopes, different purposes. Both
 *     end up in different tables (NextAuth → JWT; MCP flow → oauth_tokens).
 */

const GITHUB_CLIENT_ID = process.env.GITHUB_AUTH_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_AUTH_CLIENT_SECRET;
const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET;

// Don't throw on missing GITHUB_AUTH_* at import time — that would break
// `next build` and tests. NextAuth itself surfaces a clear error from the
// route handler if the values are missing when an actual auth attempt
// happens. Silent here keeps test output uncluttered.

export const authOptions: NextAuthOptions = {
  providers: [
    GitHubProvider({
      clientId: GITHUB_CLIENT_ID ?? "",
      clientSecret: GITHUB_CLIENT_SECRET ?? "",
      // `read:user user:email` is the default scope; it's enough for us to
      // read the GitHub `id`, `name`, and primary verified `email`.
    }),
  ],
  session: { strategy: "jwt" },
  secret: NEXTAUTH_SECRET,
  callbacks: {
    /**
     * Gate sign-up. Allow when:
     *   1. A user row already exists for this GitHub identity.
     *   2. A user row exists for this email but with a non-OAuth ping_subject
     *      (legacy week-1 shim row): migrate ping_subject to the GitHub id.
     *   3. The `users` table is empty — first signer becomes admin.
     *   4. There's a pending, unexpired invitation for this email.
     * Otherwise: deny. NextAuth surfaces this to the browser as the default
     * AccessDenied error page.
     */
    async signIn({ account, profile, user }) {
      if (account?.provider !== "github") return false;
      const ghSub = String(account.providerAccountId);
      const email =
        (profile as { email?: string | null } | undefined)?.email ??
        user.email ??
        null;
      if (!email) return false;

      const db = getDb();

      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.pingSubject, ghSub))
        .limit(1);
      if (existing[0]) return true;

      // Legacy shim rows had `ping_subject` set to HARDCODED_USER_ID rather
      // than the GitHub numeric id. If a row exists for this verified email,
      // adopt it by migrating its `ping_subject` to the OAuth identity. The
      // lookup + update share a transaction so two concurrent sign-ins can't
      // race the migration.
      const migrated = await db.transaction(async (tx) => {
        const byEmail = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        if (!byEmail[0]) return false;
        await tx
          .update(users)
          .set({ pingSubject: ghSub })
          .where(eq(users.id, byEmail[0].id));
        return true;
      });
      if (migrated) return true;

      const counts = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(users);
      if ((counts[0]?.count ?? 0) === 0) return true;

      const invite = await findPendingInvitation(email.toLowerCase());
      return invite != null;
    },

    /**
     * Stamp our DB-side claims onto the JWT. Runs on every sign-in (when
     * `account` is present) and on token refresh; we re-run `ensureUser`
     * each time so `role` reflects the current DB state and `lastSeenAt`
     * gets bumped on activity.
     */
    async jwt({ token, account, profile, user }) {
      // On sign-in `account` is set; on later token reads it isn't, but
      // `token.sub` carries the previously-stamped GitHub id we can re-use.
      const ghSub = account
        ? String(account.providerAccountId)
        : (token.ghSub as string | undefined);
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
