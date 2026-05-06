import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Week-1 schema. Recipes / oauth_tokens / tools_catalog / audit_log come in later PRs.
 *
 * `users.ping_subject` holds:
 *   - week 1: the HARDCODED_USER_ID env var value (so dev users have stable rows)
 *   - week 2+: the OIDC `sub` claim from PingOne
 */

export const messageRoleEnum = pgEnum("message_role", [
  "user",
  "assistant",
  "tool",
]);

export const userRoleEnum = pgEnum("user_role", ["admin", "user"]);

export type UserRole = (typeof userRoleEnum.enumValues)[number];

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pingSubject: text("ping_subject").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    /**
     * Coarse permission tier. The first user ever to sign in is promoted to
     * `admin`; everyone else defaults to `user`. Admins bypass per-user
     * scoping on threads/messages/usage queries; users see only their own
     * rows. Assigned in the sign-in path (`ensureUser`), not by the IdP.
     */
    role: userRoleEnum("role").notNull().default("user"),
    /**
     * Free-form per-user steering text injected into the agent's first turn
     * (alongside the connected-tools list). Set via Settings → Custom
     * instructions. NULL = no extra steering.
     */
    customInstructions: text("custom_instructions"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pingSubjectUnique: uniqueIndex("users_ping_subject_idx").on(t.pingSubject),
  }),
);

export const chatThreads = pgTable(
  "chat_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title"),
    defaultModelId: text("default_model_id").notNull(),
    /**
     * Persisted Cursor `agentId` for this thread. Null until the first turn
     * with the cursor runtime; populated by `DbThreadAgentStore` so agents
     * survive restarts.
     */
    cursorAgentId: text("cursor_agent_id"),
    /**
     * Stable identity of the MCP-server set this agent was created with.
     * Today: sorted provider names joined with `,` (e.g. `"github"` or
     * `"github,notion"`). Empty string = no MCP. NULL = legacy agent created
     * before MCP wiring. When the current turn's signature differs, the
     * runtime force-recreates the agent so its tool surface stays in sync
     * with the user's connected providers.
     */
    mcpSignature: text("mcp_signature"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index("chat_threads_user_idx").on(
      t.userId,
      sql`${t.updatedAt} DESC`,
    ),
  }),
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    /** ModelId from packages/agent/models for assistant messages; null otherwise. */
    modelId: text("model_id"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    /** Tool calls emitted by the assistant on this turn. */
    toolCalls: jsonb("tool_calls"),
    /** Tool execution results, paired by tool_call_id. */
    toolResults: jsonb("tool_results"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    threadIdx: index("chat_messages_thread_idx").on(t.threadId, t.createdAt),
  }),
);

/**
 * Per-user OAuth tokens for connected providers (GitHub, Notion, Google, …).
 *
 * `access_token` and `refresh_token` are stored as opaque strings produced by
 * `encryptSecret(...)` in apps/web/lib/oauth/crypto.ts (AES-256-GCM with the
 * key from `OAUTH_ENCRYPTION_KEY`). Never write a plaintext token here.
 */
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    scope: text("scope"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userProviderUnique: uniqueIndex("oauth_tokens_user_provider_idx").on(
      t.userId,
      t.provider,
    ),
  }),
);

/**
 * Workspace invitations issued by admins.
 *
 * An admin generates a row here with `email`, `role`, and a one-shot
 * `token`; the resulting `/invite/<token>` URL is shared out-of-band. When
 * the invitee signs in for the first time and `ensureUser` upserts their
 * row, it looks for a pending invitation matching their email and applies
 * the pre-assigned `role`, marking `accepted_at` so the invite can't be
 * reused. Rows where `expires_at < now()` are treated as expired even if
 * `accepted_at` is still null.
 *
 * `email` is intentionally NOT unique — re-inviting the same address
 * supersedes the older pending invite at consumption time (newest pending
 * row wins).
 */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    role: userRoleEnum("role").notNull().default("user"),
    /** Cryptographically random hex token used in the invite URL. */
    token: text("token").notNull(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Null while pending; set to now() when consumed by `ensureUser`. */
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /** Hard cutoff — 7 days after `created_at` by convention. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tokenUnique: uniqueIndex("invitations_token_idx").on(t.token),
    emailIdx: index("invitations_email_idx").on(t.email),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type ChatThread = typeof chatThreads.$inferSelect;
export type NewChatThread = typeof chatThreads.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type OAuthToken = typeof oauthTokens.$inferSelect;
export type NewOAuthToken = typeof oauthTokens.$inferInsert;
export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
