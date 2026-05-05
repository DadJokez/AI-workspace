import { sql } from "drizzle-orm";
import {
  boolean,
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

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pingSubject: text("ping_subject").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    isAdmin: boolean("is_admin").notNull().default(false),
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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type ChatThread = typeof chatThreads.$inferSelect;
export type NewChatThread = typeof chatThreads.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type OAuthToken = typeof oauthTokens.$inferSelect;
export type NewOAuthToken = typeof oauthTokens.$inferInsert;
