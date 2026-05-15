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
 * Core workspace schema. Recipe definitions, tool catalog, attestations, and
 * audit log land in later PRs.
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

export const recipeRunStatusEnum = pgEnum("recipe_run_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);

export type RecipeRunStatus = (typeof recipeRunStatusEnum.enumValues)[number];

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
    /**
     * Rolling summary of durable thread context. Used by fresh-agent-per-turn
     * execution to avoid replaying the entire raw conversation forever.
     */
    summary: text("summary"),
    /** Last time the rolling summary was regenerated. NULL = never summarized. */
    summaryUpdatedAt: timestamp("summary_updated_at", { withTimezone: true }),
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
    /** Runtime that produced assistant messages (`cursor` or `bedrock`). */
    runtime: text("runtime"),
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
 * Admin-issued invitation links for onboarding new users. An admin generates
 * a row here (with a random token + 7-day expiry); the prospective user
 * follows /invite/<token> to a sign-in page. When they actually authenticate
 * for the first time, `ensureUser` looks for a matching pending invitation
 * by email and applies the invited role atomically (also stamping
 * `acceptedAt` so the token can't be reused).
 *
 * `email` is not unique — re-issuing an invite for the same address is
 * legitimate (lost link, expired link). Lookup filters on `acceptedAt IS
 * NULL AND expiresAt > now()` to find the active invite.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    role: userRoleEnum("role").notNull().default("user"),
    token: text("token").notNull(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
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

/**
 * Durable execution records for recipes, scheduled jobs, and workflow-style
 * agent runs. The `recipe_id` is intentionally nullable and not yet a foreign
 * key because recipe definitions ship in a later migration; early runs can be
 * keyed by `recipe_slug` while the catalog is still hardcoded.
 */
export const recipeRuns = pgTable(
  "recipe_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recipeId: uuid("recipe_id"),
    recipeSlug: text("recipe_slug"),
    threadId: uuid("thread_id").references(() => chatThreads.id, {
      onDelete: "set null",
    }),
    triggerType: text("trigger_type").notNull().default("manual"),
    status: recipeRunStatusEnum("status").notNull().default("queued"),
    runtime: text("runtime"),
    modelId: text("model_id"),
    inputs: jsonb("inputs"),
    outputs: jsonb("outputs"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index("recipe_runs_user_idx").on(
      t.userId,
      sql`${t.createdAt} DESC`,
    ),
    statusIdx: index("recipe_runs_status_idx").on(t.status),
    recipeIdx: index("recipe_runs_recipe_idx").on(t.recipeId),
    threadIdx: index("recipe_runs_thread_idx").on(t.threadId),
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
export type RecipeRun = typeof recipeRuns.$inferSelect;
export type NewRecipeRun = typeof recipeRuns.$inferInsert;
