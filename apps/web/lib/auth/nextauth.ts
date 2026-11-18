import type { NextAuthOptions } from "next-auth";
import type { EmailConfig } from "next-auth/providers/email";
import GitHubProvider from "next-auth/providers/github";
import type { OAuthConfig } from "next-auth/providers/oauth";
import { getDb, users, type Database } from "@ai-workspace/db";
import { and, eq, like, not, sql } from "drizzle-orm";
import {
  MAGIC_LINK_MAX_AGE_SECONDS,
  sendMagicLinkEmail,
} from "@/lib/magic-link-email";
import { githubProviderEndpoints } from "@/lib/auth/github-provider-endpoints";
import { createNextAuthAdapter } from "@/lib/auth/nextauth-adapter";
import {
  authRequestContext,
  clientIpFromForwardedFor,
  recordAuthEvent,
  type AuthDenialReason,
  type AuthSignInPhase,
} from "@/lib/auth/auth-audit";
import {
  oidcAccessDenial,
  provisionOidcUser,
  readOidcClaims,
} from "@/lib/auth/oidc-sign-in";
import { SIGN_IN_DENIAL_MESSAGES } from "@/lib/auth/sign-in-denial";
import {
  GITHUB_API_URL,
  GITHUB_WEB_URL,
  MAGIC_LINK,
  OIDC,
  OIDC_ENABLED,
  OIDC_SUBJECT_PREFIX,
  PUBLIC_BASE_URL,
  SESSION_MAX_AGE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  magicLinksAvailable,
  parseAuthProviders,
  type AuthProviderId,
  type OidcConfig,
} from "@/lib/deployment-config";
import { ensureUser, findPendingInvitation } from "@/lib/users";

export {
  KNOWN_AUTH_PROVIDERS,
  SESSION_MAX_AGE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  parseAuthProviders,
  type AuthProviderId,
} from "@/lib/deployment-config";

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
 *     OAuth is the optional secondary; "pingone" is enterprise OIDC.
 *   - `signIn` is the security gate for EVERY provider. GitHub and magic
 *     links: only allow first-ever signup, an existing user, or an email with
 *     a pending invitation. OIDC: the identity provider's groups claim decides
 *     (`lib/auth/oidc-sign-in.ts`); invitations are not consulted. For magic
 *     links the gate runs at REQUEST time (`email.verificationRequest`) so
 *     strangers never receive a link, and again at link-click time.
 *   - The magic-link token is hashed by next-auth core (SHA-256 of
 *     token+NEXTAUTH_SECRET) before storage, expires after 15 minutes, and is
 *     single-use (adapter deletes on read).
 *   - An OAuth or OIDC identity is matched on its subject and never linked to
 *     an existing user by address: neither provider sets
 *     `allowDangerousEmailAccountLinking`. A GitHub sign-in whose address
 *     already belongs to a user with another identity is refused. The one
 *     address-based link is OIDC adoption, off unless the deployment opts in
 *     (`provisionOidcUser`).
 *   - Provider GitHub OAuth here is separate from the per-user GitHub
 *     MCP-token flow at /api/oauth/github/* — different scopes, purposes.
 *   - Sessions carry an explicit idle expiry (SESSION_MAX_AGE_SECONDS, 24h
 *     unless the deployment sets it) rather than next-auth's 30-day default.
 *   - Sign-in, sign-in-denied and sign-out are appended to the audit ledger
 *     (`lib/auth/auth-audit.ts`); no token material is ever recorded.
 */

const GITHUB_CLIENT_ID = process.env.GITHUB_AUTH_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_AUTH_CLIENT_SECRET;
const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET;

// Don't throw on missing GITHUB_AUTH_* at import time — that would break
// `next build` and tests. NextAuth itself surfaces a clear error from the
// route handler if the values are missing when an actual auth attempt
// happens. Silent here keeps test output uncluttered.

const enabledProviders = parseAuthProviders(process.env.AUTH_PROVIDERS);

/**
 * Provider ids a person can sign in with right now — drives the login page
 * UI. Magic links drop out once MAGIC_LINK_SUNSET passes, and OIDC is absent
 * while its settings are incomplete.
 */
export function enabledAuthProviders(now: Date = new Date()): AuthProviderId[] {
  return enabledProviders.filter((id) => {
    if (id === "email") return magicLinksAvailable(now);
    if (id === "pingone") return OIDC !== null;
    return true;
  });
}

/**
 * Rate limit for magic-link requests, enforced by the [...nextauth] route
 * wrapper across two buckets sharing this config:
 *
 *   1. `magic-link-email:<email>` — the REAL cap, keyed on the normalized
 *      recipient alone. This endpoint is unauthenticated and world-reachable
 *      (unlike the invite limiter, which keys on an authenticated admin id),
 *      and callers can spoof X-Forwarded-For, so nothing client-supplied may
 *      participate in the enforcing key. This is what stops email-bombing an
 *      invited tester and burning SES quota.
 *   2. `magic-link:<email>:<ip>` — secondary, best-effort defense-in-depth
 *      against single-source floods when the forwarding header is honest
 *      (see magicLinkRateLimitKey). Never the cap.
 */
export const magicLinkRateLimit = {
  maxRequestBytes: 8 * 1024,
  maxMessageChars: 512,
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
};

/** The primary, spoof-proof bucket: normalized recipient email only. */
export function magicLinkEmailRateLimitKey(email: string): string {
  return `magic-link-email:${email.trim().toLowerCase()}`;
}

/**
 * The secondary email+IP bucket. Uses the RIGHTMOST x-forwarded-for entry —
 * the hop our own ALB appended — because clients can prepend arbitrary
 * values, which makes the leftmost entry attacker-controlled. Best-effort
 * only until the deployment has a trusted client-IP source; the email-only
 * bucket above is the enforcement that matters.
 */
export function magicLinkRateLimitKey(
  email: string,
  xForwardedFor: string | null,
): string {
  const ip = clientIpFromForwardedFor(xForwardedFor) ?? "unknown";
  return `magic-link:${email.trim().toLowerCase()}:${ip}`;
}

/**
 * MAGIC_LINK_ALLOWED_DOMAINS: true when the address's domain is on the list,
 * or when there is no list. The whole domain must match, case-insensitively:
 * `example.com` admits neither `sub.example.com` nor `evil-example.com`. An
 * address with anything but one `@` is refused, so the domain compared is the
 * domain mail would go to.
 */
export function magicLinkDomainAllowed(
  email: string,
  allowedDomains: readonly string[] | null = MAGIC_LINK.allowedDomains,
): boolean {
  if (allowedDomains === null) return true;
  const parts = email.trim().toLowerCase().split("@");
  return parts.length === 2 && allowedDomains.includes(parts[1]!);
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
      // Reached only after the gate allowed the request, so the ledger holds
      // one row per link actually issued. The link itself is never recorded.
      await recordAuthEvent({
        action: "auth_magic_link_requested",
        authProvider: "email",
        email: identifier,
        request: await authRequestContext(),
      });
      await sendMagicLinkEmail({ to: identifier, url, expires });
    },
  };
}

type OidcClaims = Record<string, unknown>;

/**
 * Generic OIDC through next-auth's built-in OAuth support: discovery from the
 * issuer, authorization code flow with PKCE, state and nonce, and the ID token
 * verified against the issuer's keys by openid-client before any claim is
 * read. The client secret is read here, from the environment, and nowhere
 * else.
 */
function oidcProvider(oidc: OidcConfig): OAuthConfig<OidcClaims> {
  return {
    id: "pingone",
    name: oidc.displayName,
    type: "oauth",
    wellKnown: `${oidc.issuer}/.well-known/openid-configuration`,
    idToken: true,
    checks: ["pkce", "state", "nonce"],
    authorization: { params: { scope: oidc.scopes } },
    clientId: oidc.clientId,
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
    userinfo: {
      /**
       * The verified ID token is the claim set. Only when it carries no
       * groups claim is userinfo asked, and only that one claim is taken from
       * the answer: identity (`sub`, `email`, `email_verified`) always comes
       * from the signed token. A userinfo answer for another subject, or no
       * answer, leaves the claim absent, which the gate treats as unreadable.
       */
      async request({ tokens, client }) {
        // next-auth types the token set as plain parameters; at runtime it is
        // openid-client's TokenSet, whose `claims()` is the payload of the ID
        // token it has just validated.
        const claims = (
          tokens as unknown as { claims(): OidcClaims }
        ).claims();
        if (
          Object.hasOwn(claims, oidc.groupsClaim) ||
          !tokens.access_token ||
          !client.issuer.metadata.userinfo_endpoint
        ) {
          return claims;
        }
        try {
          const userinfo: OidcClaims = await client.userinfo(
            tokens.access_token,
          );
          if (
            userinfo.sub !== claims.sub ||
            !Object.hasOwn(userinfo, oidc.groupsClaim)
          ) {
            return claims;
          }
          return { ...claims, [oidc.groupsClaim]: userinfo[oidc.groupsClaim] };
        } catch {
          return claims;
        }
      },
    },
    /**
     * Must not throw: next-auth logs the whole claim set when it does. Claims
     * that do not make an identity get a subject no user can have, and the
     * `signIn` gate, which reads the same claims, refuses and audits them.
     */
    profile(claims) {
      const read = readOidcClaims(claims, oidc);
      return read.ok
        ? {
            id: read.identity.subject,
            email: read.identity.email,
            name: read.identity.displayName,
          }
        : { id: OIDC_SUBJECT_PREFIX, email: null, name: null };
    },
  };
}

async function userExistsWithEmail(
  db: Database,
  address: string,
  options: { includeOidcUsers: boolean },
): Promise<boolean> {
  const sameAddress = sql`lower(${users.email}) = ${address}`;
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(
      options.includeOidcUsers
        ? sameAddress
        : and(
            sameAddress,
            not(like(users.pingSubject, `${OIDC_SUBJECT_PREFIX}%`)),
          ),
    )
    .limit(1);
  return existing[0] !== undefined;
}

/**
 * May an address with no user yet create one? Yes when the users table is
 * empty (first-signer bootstrap) or when it holds a pending unexpired
 * invitation. The bootstrap is off whenever OIDC is enabled: there the
 * identity provider's groups decide who gets in and who is an admin, so an
 * empty table must not admit whoever arrives first by another route.
 */
async function newAddressAllowedToSignIn(
  db: Database,
  address: string,
): Promise<boolean> {
  if (!OIDC_ENABLED) {
    const counts = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users);
    if ((counts[0]?.count ?? 0) === 0) return true;
  }

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
        ...githubProviderEndpoints(GITHUB_WEB_URL, GITHUB_API_URL),
      }),
    );
  }
  // Registration is decided once, at load; the gate re-checks the sunset on
  // every request so a long-running server stops honouring links on time.
  if (enabledProviders.includes("email") && magicLinksAvailable()) {
    providers.push(magicLinkProvider());
  }
  if (enabledProviders.includes("pingone") && OIDC) {
    providers.push(oidcProvider(OIDC));
  }
  return providers;
}

type SignInParams = Parameters<
  NonNullable<NonNullable<NextAuthOptions["callbacks"]>["signIn"]>
>[0];

interface SignInDecision {
  allowed: boolean;
  email?: string | null;
  reason?: AuthDenialReason;
  phase?: AuthSignInPhase;
}

/**
 * OIDC sign-ins whose gate created the user. next-auth hands the same
 * `account` object to the `signIn` callback and to the `signIn` event, and by
 * the time it computes `isNewUser` the row already exists.
 */
const oidcNewUserSignIns = new WeakSet<object>();

/**
 * Gate sign-up. For GitHub and magic links, allow when:
 *   1. The `users` table is empty — first signer becomes admin (off whenever
 *      OIDC is enabled).
 *   2. A user row already exists for this identity: the GitHub subject, or
 *      for a magic link the email address.
 *   3. There's a pending, unexpired invitation for this email.
 * Otherwise: deny. OIDC has its own rules (`evaluateOidcSignIn`).
 *
 * For the email provider this runs TWICE: at link-request time
 * (`email.verificationRequest === true` — deny means the stranger never
 * receives a link; the login page shows the same neutral "if that address is
 * invited, a link is on its way" copy either way, so denial is not an
 * account-existence oracle) and again at link-click time (`email` undefined —
 * covers invites revoked between request and click).
 *
 * Returns the decision rather than a bare boolean so the caller can audit the
 * denial (who was turned away, at which phase, and why).
 */
async function evaluateSignIn({
  account,
  profile,
  user,
  email,
}: SignInParams): Promise<SignInDecision> {
  const db = getDb();

  if (account?.provider === "email") {
    const phase: AuthSignInPhase = email?.verificationRequest
      ? "link_request"
      : "callback";
    const address = (user?.email ?? String(account.providerAccountId))
      ?.trim()
      .toLowerCase();
    if (!address) return { allowed: false, reason: "missing_email", phase };
    // Both restrictions hold at both phases: a link issued before the sunset
    // or before the list was tightened is refused when it is clicked. They
    // run after the route's rate limit and read nothing about any account,
    // and the request phase answers every refusal with the same neutral copy,
    // so neither the rule nor an account's existence can be probed.
    if (!magicLinksAvailable()) {
      return {
        allowed: false,
        email: address,
        phase,
        reason: "magic_link_sunset",
      };
    }
    if (!magicLinkDomainAllowed(address)) {
      return {
        allowed: false,
        email: address,
        phase,
        reason: "magic_link_domain_not_allowed",
      };
    }
    // Same gate for the request phase (email.verificationRequest) and
    // the callback phase — the callback's token validity/single-use is
    // already enforced by next-auth core + the adapter by this point.
    // The response copy is neutral, but an allowed request still includes
    // SES latency while a denied request does not. That low-sensitivity
    // timing signal is accepted for this invite-only tester phase.
    //
    // An OIDC user is not "an existing user" here: a magic link must never
    // sign someone in as an identity the identity provider gates. Such an
    // address needs an invitation like any other and gets its own user.
    const allowed =
      (await userExistsWithEmail(db, address, { includeOidcUsers: false })) ||
      (await newAddressAllowedToSignIn(db, address));
    return {
      allowed,
      email: address,
      phase,
      ...(allowed ? {} : { reason: "not_invited" as const }),
    };
  }

  if (account?.provider === "github") {
    const ghSub = String(account.providerAccountId);
    const ghEmail =
      (profile as { email?: string | null } | undefined)?.email ??
      user.email ??
      null;
    if (!ghEmail) return { allowed: false, reason: "missing_email" };

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.pingSubject, ghSub))
      .limit(1);
    if (existing[0]) return { allowed: true, email: ghEmail };

    // A GitHub identity is never attached to an existing user by address.
    // Someone who first signed in by magic link keeps using magic links.
    const address = ghEmail.trim().toLowerCase();
    if (await userExistsWithEmail(db, address, { includeOidcUsers: true })) {
      return { allowed: false, email: ghEmail, reason: "email_in_use" };
    }

    const allowed = await newAddressAllowedToSignIn(db, ghEmail);
    return {
      allowed,
      email: ghEmail,
      ...(allowed ? {} : { reason: "not_invited" as const }),
    };
  }

  if (account?.provider === "pingone" && OIDC) {
    return evaluateOidcSignIn(db, OIDC, account, profile);
  }

  return { allowed: false, reason: "unsupported_provider" };
}

/**
 * The OIDC gate: read the claims, apply OIDC_REQUIRED_GROUP, then find or
 * create the user and sync role and groups. The user row is written here, in
 * the gate, so that next-auth afterwards finds it by subject and never falls
 * back to its own lookup by address.
 */
async function evaluateOidcSignIn(
  db: Database,
  oidc: OidcConfig,
  account: NonNullable<SignInParams["account"]>,
  profile: SignInParams["profile"],
): Promise<SignInDecision> {
  const claims = readOidcClaims(profile, oidc);
  if (!claims.ok) return { allowed: false, reason: claims.reason };
  const { identity } = claims;
  if (identity.subject !== account.providerAccountId) {
    return { allowed: false, reason: "invalid_subject" };
  }

  const denial = oidcAccessDenial(identity, oidc);
  if (denial) return { allowed: false, email: identity.email, reason: denial };

  try {
    const result = await provisionOidcUser(db, identity, oidc);
    if (result.created) oidcNewUserSignIns.add(account);
    if (result.adopted || result.roleChange) {
      const request = await authRequestContext();
      if (result.adopted) {
        await recordAuthEvent({
          action: "auth_identity_adopted",
          actorUserId: result.user.id,
          authProvider: account.provider,
          request,
        });
      }
      if (result.roleChange) {
        await recordAuthEvent({
          action: "auth_role_synced",
          actorUserId: result.user.id,
          authProvider: account.provider,
          roleChange: result.roleChange,
          request,
        });
      }
    }
    return { allowed: true, email: identity.email };
  } catch (error) {
    // Name only: a driver error's message can echo row values.
    console.error(
      `[auth] OIDC user provisioning failed: ${
        error instanceof Error ? error.name : "unknown error"
      }`,
    );
    return {
      allowed: false,
      email: identity.email,
      reason: "provisioning_failed",
    };
  }
}

export const authOptions: NextAuthOptions = {
  providers: buildProviders(),
  // Required by the email provider; also puts OAuth on the adapter path
  // (attached unconditionally so behavior never depends on which allowlist
  // combination is active). Sessions remain JWT regardless.
  adapter: createNextAuthAdapter(),
  session: {
    strategy: "jwt",
    maxAge: SESSION_MAX_AGE_SECONDS,
    updateAge: SESSION_UPDATE_AGE_SECONDS,
  },
  secret: NEXTAUTH_SECRET,
  pages: {
    // Replace NextAuth's default sign-in / error pages with our own /login.
    // Errors land back here as `?error=AccessDenied` etc, surfaced inline.
    signIn: "/login",
    error: "/login",
  },
  events: {
    /**
     * Successful sign-in. `user.id` is the DB uuid (every provider routes
     * through the adapter), so the row joins straight to `users` in the admin
     * audit view. Nothing from `account` — access/id tokens included — is
     * recorded; only the provider id.
     */
    async signIn({ user, account, isNewUser }) {
      await recordAuthEvent({
        action: "auth_sign_in",
        actorUserId: user?.id ?? null,
        authProvider: account?.provider ?? null,
        isNewUser:
          account && oidcNewUserSignIns.has(account) ? true : isNewUser,
        request: await authRequestContext(),
      });
    },

    /** Sign-out. JWT strategy, so the ended session arrives as `token`. */
    async signOut({ token }) {
      await recordAuthEvent({
        action: "auth_sign_out",
        actorUserId:
          typeof token?.userId === "string" ? token.userId : null,
        request: await authRequestContext(),
      });
    },
  },
  callbacks: {
    /**
     * The sign-in gate (see `evaluateSignIn`). Every denial is appended to the
     * audit ledger — that record is the point of the gate for an access
     * review. Denials at the magic-link REQUEST phase are reachable by
     * unauthenticated callers, so they are bounded by the same per-email rate
     * limit that already caps that endpoint (5 / 15 min, see
     * `magicLinkRateLimit`) and by audit retention.
     *
     * A refusal the person can act on comes back as a redirect to the login
     * page carrying its reason code; the page turns the code into a sentence.
     * Magic-link refusals never do: they must all look alike.
     */
    async signIn(params) {
      const decision = await evaluateSignIn(params);
      if (decision.allowed) return true;
      await recordAuthEvent({
        action: "auth_sign_in_denied",
        authProvider: params.account?.provider ?? null,
        email: decision.email,
        reason: decision.reason,
        phase: decision.phase,
        request: await authRequestContext(),
      });
      const { reason } = decision;
      const explained =
        reason !== undefined &&
        Object.hasOwn(SIGN_IN_DENIAL_MESSAGES, reason) &&
        (params.account?.provider === "pingone" || reason === "email_in_use");
      return explained
        ? `${PUBLIC_BASE_URL}/login?error=AccessDenied&reason=${reason}`
        : false;
    },

    /**
     * Stamp our DB-side claims onto the JWT.
     *
     * Sign-in (`account` present):
     *   - email and pingone: the row already exists by now (the adapter flow
     *     resolved or created it; for OIDC the gate did) — `user.id` is our
     *     DB uuid; re-read it for the role.
     *   - github: run `ensureUser` keyed by the GitHub subject, exactly as
     *     before the adapter existed.
     * Refresh (no `account`): re-read by `ghSub` (GitHub-originated tokens)
     * or by `userId` (magic-link- and OIDC-originated tokens) so role changes
     * take effect without a fresh sign-in.
     */
    async jwt({ token, account, profile, user }) {
      if (account?.provider === "email" || account?.provider === "pingone") {
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
        // Magic-link or OIDC session refresh: no external subject on the token.
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
