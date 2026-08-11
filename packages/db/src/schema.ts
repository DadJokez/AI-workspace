import { sql } from "drizzle-orm";
import {
  index,
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Core workspace schema.
 *
 * `users.ping_subject` holds the external identity-provider subject:
 *   - current POC: GitHub OAuth account id from NextAuth
 *   - enterprise: the OIDC `sub` claim from PingOne/PingFederate
 */

export const messageRoleEnum = pgEnum("message_role", [
  "user",
  "assistant",
  "tool",
]);

export const userRoleEnum = pgEnum("user_role", ["admin", "user"]);

export type UserRole = (typeof userRoleEnum.enumValues)[number];

export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);

export type RunStatus = (typeof runStatusEnum.enumValues)[number];

export const memoryCaptureStatusEnum = pgEnum("memory_capture_status", [
  "pending",
  "processing",
  "processed",
  "failed",
  "skipped",
]);

export type MemoryCaptureStatus =
  (typeof memoryCaptureStatusEnum.enumValues)[number];

export const userMemoryStatusEnum = pgEnum("user_memory_status", [
  "suggested",
  "approved",
  "dismissed",
  "archived",
]);

export type UserMemoryStatus = (typeof userMemoryStatusEnum.enumValues)[number];

export const artifactReviewCommentStatusEnum = pgEnum(
  "artifact_review_comment_status",
  ["open", "addressing", "addressed"],
);

export type ArtifactReviewCommentStatus =
  (typeof artifactReviewCommentStatusEnum.enumValues)[number];

export const chatThreadBranchSourceTypeEnum = pgEnum(
  "chat_thread_branch_source_type",
  ["message", "thread", "artifact", "app_version", "proposal"],
);

export type ChatThreadBranchSourceType =
  (typeof chatThreadBranchSourceTypeEnum.enumValues)[number];

export const auditLogStatusEnum = pgEnum("audit_log_status", [
  "started",
  "succeeded",
  "failed",
  "denied",
]);

export type AuditLogStatus = (typeof auditLogStatusEnum.enumValues)[number];

export const toolCatalogActionEnum = pgEnum("tool_catalog_action", [
  "read",
  "write",
  "admin",
]);

export type ToolCatalogAction =
  (typeof toolCatalogActionEnum.enumValues)[number];

export const userToolAttestationScopeEnum = pgEnum(
  "user_tool_attestation_scope",
  ["provider", "category", "tool"],
);

export type UserToolAttestationScope =
  (typeof userToolAttestationScopeEnum.enumValues)[number];

export const mcpServerTransportEnum = pgEnum("mcp_server_transport", [
  "http",
  "sse",
  "stdio",
]);

export type McpServerTransport =
  (typeof mcpServerTransportEnum.enumValues)[number];

export const mcpServerStatusEnum = pgEnum("mcp_server_status", [
  "active",
  "disabled",
  "planned",
]);

export type McpServerStatus = (typeof mcpServerStatusEnum.enumValues)[number];

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
    /**
     * Preferred model id for new chats. Stored as the product model id
     * (for example `sonnet-4-5`) so the preference follows
     * the user across browsers and machines. NULL = use app default.
     */
    defaultModelId: text("default_model_id"),
    /**
     * What the user named their assistant in the first-run wizard (specs/005).
     * Shows in the chat header and assistant message labels. NULL = the user
     * hasn't named it; UI falls back to "Assistant".
     */
    assistantName: text("assistant_name"),
    /**
     * When the user finished (or skipped) the first-run welcome tour.
     * NULL = never seen it; the chat shell shows the tour once on sign-in.
     */
    tourCompletedAt: timestamp("tour_completed_at", { withTimezone: true }),
    /**
     * When the user last opened the daily digest. The digest rolls up
     * scheduled-run results and new shares since this instant ("since you
     * were last here"). `lastSeenAt` can't serve here — it is bumped on
     * every session load. NULL = never viewed; the digest falls back to
     * the trailing 24 hours.
     */
    digestViewedAt: timestamp("digest_viewed_at", { withTimezone: true }),
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

/**
 * Per-purpose model enablement (#300) — the DB half of the model registry.
 * Model metadata (provider, family, cost, capabilities) stays in
 * `packages/agent/src/models.ts`; this table says which registered model may
 * serve which purpose/lane. Admin-editable later (#302). A model with no row
 * for a purpose is DISABLED for it — so a newly registered model is disabled
 * everywhere until qualified (#301) and explicitly enabled. Seeded by
 * migration with the three Claude tiers enabled for every current purpose
 * (no behavior change).
 */
export const modelEnablement = pgTable(
  "model_enablement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Product model id from packages/agent (e.g. "sonnet-4-5"). */
    modelId: text("model_id").notNull(),
    /** A ModelPurpose: chat, fast-local, tool-local, durable-local, summaries, routing, memory-capture. */
    purpose: text("purpose").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    modelPurposeUnique: uniqueIndex("model_enablement_model_purpose_idx").on(
      t.modelId,
      t.purpose,
    ),
    purposeIdx: index("model_enablement_purpose_idx").on(t.purpose, t.enabled),
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
    pinned: boolean("pinned").notNull().default(false),
    defaultModelId: text("default_model_id").notNull(),
    /**
     * Legacy runtime agent id field. Kept for migration compatibility; current
     * Bedrock/AgentCore execution does not use it for continuity.
     */
    cursorAgentId: text("cursor_agent_id"),
    /**
     * Sticky tool-discovery activation set (#384): sorted provider names
     * joined with `,` (e.g. `"github"` or `"github,notion"`). Providers are
     * only ever ADDED for the life of the thread — stickiness is the
     * tools-cache guarantee. Written by `ensureThreadActivation`
     * (apps/web/lib/thread-activation.ts).
     * NULL/empty = nothing activated yet. (The column predates #384 with
     * this exact format documented but no writers.)
     */
    mcpSignature: text("mcp_signature"),
    /**
     * Reserved for a rolling summary of durable thread context. No writer has
     * shipped (#413/#416 territory), so this is NULL for every thread today;
     * nothing reads it. Columns kept so a future summarizer needs no
     * migration.
     */
    summary: text("summary"),
    /** See `summary` — no writer shipped; NULL everywhere. */
    summaryUpdatedAt: timestamp("summary_updated_at", { withTimezone: true }),
    /**
     * Short user-facing recap for sidebar hover previews. Separate from the
     * durable runtime summary so UI metadata can stay compact.
     */
    previewSummary: text("preview_summary"),
    previewSummaryUpdatedAt: timestamp("preview_summary_updated_at", {
      withTimezone: true,
    }),
    /** "auto" titles may be refreshed after turns; "manual" titles are left alone. */
    titleSource: text("title_source").notNull().default("auto"),
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
    userPinnedIdx: index("chat_threads_user_pinned_updated_idx").on(
      t.userId,
      sql`${t.pinned} DESC`,
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
    /** Runtime that produced assistant messages (`bedrock` or `agentcore`). */
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
    providerMetadata: jsonb("provider_metadata"),
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
 * NULL AND revokedAt IS NULL AND expiresAt > now()` to find the active invite.
 * Email delivery is tracked here so admins can retry failed sends without
 * losing the underlying single-purpose token.
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
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    emailStatus: text("email_status")
      .$type<"not_sent" | "sent" | "failed">()
      .notNull()
      .default("not_sent"),
    emailSendAttempts: integer("email_send_attempts").notNull().default(0),
    lastEmailAttemptedAt: timestamp("last_email_attempted_at", {
      withTimezone: true,
    }),
    lastEmailSentAt: timestamp("last_email_sent_at", { withTimezone: true }),
    lastEmailError: text("last_email_error"),
    lastEmailMessageId: text("last_email_message_id"),
    // The Google OAuth app runs in External + Testing mode, so only emails
    // hand-added to its test-user list can connect Google tools. Google has
    // no API for that list, so an admin records here when they've added the
    // invitee in the Google console. Null = not registered yet.
    googleTestUserRegisteredAt: timestamp("google_test_user_registered_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tokenUnique: uniqueIndex("invitations_token_idx").on(t.token),
    emailIdx: index("invitations_email_idx").on(t.email),
    revokedIdx: index("invitations_revoked_idx").on(t.revokedAt),
    emailStatusIdx: index("invitations_email_status_idx").on(t.emailStatus),
  }),
);

/**
 * NextAuth email (magic-link) verification tokens. One row per outstanding
 * sign-in link. `token` is NOT the raw link token: next-auth v4 hashes it
 * (SHA-256 of `${token}${NEXTAUTH_SECRET}`) before it ever reaches the
 * adapter, so a DB leak exposes nothing clickable. Rows are single-use —
 * `useVerificationToken` deletes on read — and short-lived (15-minute
 * `maxAge` on the email provider; expiry is enforced by next-auth core
 * against `expires`). Expired never-clicked rows are swept opportunistically
 * when the same identifier requests a new link.
 */
export const verificationTokens = pgTable(
  "verification_tokens",
  {
    /** The email address the link was issued to (lowercased by next-auth). */
    identifier: text("identifier").notNull(),
    /** SHA-256(rawToken + NEXTAUTH_SECRET), hex — hashed by next-auth core. */
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({
      name: "verification_tokens_identifier_token_pk",
      columns: [t.identifier, t.token],
    }),
  }),
);

/**
 * Skills are the user-facing primitive: a saved, shareable agent definition
 * `{system_prompt, mcp_providers, model}` that users create, clone, edit,
 * run, schedule, and share. Execution always materializes through the
 * `AgentRuntime` seam and re-gates on the *executing* user's provider
 * connections and attestations — owning or receiving a skill never grants
 * credentials.
 */
export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** URL-safe, globally unique — skills are shareable across users. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    systemPrompt: text("system_prompt").notNull(),
    /** Logical model tier the dispatcher respects. */
    modelId: text("model_id").notNull(),
    /** Provider slugs (e.g. ["github"]); mounting is still gated per-run. */
    mcpProviders: jsonb("mcp_providers").$type<string[]>().notNull(),
    /** Reserved for parameterized skills; unused in v1. */
    paramsSchema: jsonb("params_schema"),
    visibility: text("visibility").notNull().default("private"),
    /** Provenance for the clone graph (future proposal signal). */
    clonedFromSkillId: uuid("cloned_from_skill_id").references(
      (): AnyPgColumn => skills.id,
      { onDelete: "set null" },
    ),
    isStarter: boolean("is_starter").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    slugUnique: uniqueIndex("skills_slug_idx").on(t.slug),
    ownerIdx: index("skills_owner_idx").on(t.ownerUserId),
    starterIdx: index("skills_starter_idx").on(t.isStarter),
  }),
);

/**
 * Recurring execution of a skill. A leased scheduler tick (hosted in the
 * chat-run worker process) claims due rows and enqueues `runs` rows with
 * `trigger_type = "scheduled"`; the existing worker executes them through
 * the runtime seam. `next_run_at` always advances from the scheduled
 * occurrence time, not the claim time, so delayed ticks do not drift.
 */
export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    /** Cron expression (UI offers presets); evaluated in `timezone`. */
    cadence: text("cadence").notNull(),
    /** IANA zone name; next_run_at computation is DST-safe. */
    timezone: text("timezone").notNull(),
    /** Output thread. NULL = create a dedicated thread on first fire. */
    targetThreadId: uuid("target_thread_id").references(() => chatThreads.id, {
      onDelete: "set null",
    }),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    /** Lease fields — same claim semantics as the chat-run worker. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    dueIdx: index("schedules_due_idx").on(t.enabled, t.nextRunAt),
    userIdx: index("schedules_user_idx").on(t.userId),
    skillIdx: index("schedules_skill_idx").on(t.skillId),
  }),
);

/**
 * Event-driven execution definitions. V1 accepts GitHub webhooks, but source,
 * filters, and thread mode stay generic so another governed event source can
 * use the same lifecycle later.
 */
export const eventTriggers = pgTable(
  "event_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("github"),
    repository: text("repository").notNull(),
    eventType: text("event_type").notNull(),
    action: text("action"),
    filters: jsonb("filters").notNull().default(sql`'{}'::jsonb`),
    threadMode: text("thread_mode").notNull().default("dedicated"),
    targetThreadId: uuid("target_thread_id").references(() => chatThreads.id, {
      onDelete: "set null",
    }),
    enabled: boolean("enabled").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    lookupIdx: index("event_triggers_lookup_idx").on(
      t.source,
      t.repository,
      t.eventType,
      t.enabled,
      t.deletedAt,
    ),
    userIdx: index("event_triggers_user_idx").on(t.userId, t.createdAt),
    skillIdx: index("event_triggers_skill_idx").on(t.skillId),
  }),
);

/**
 * Durable execution ledger for chat turns, workflow runs, skill runs,
 * scheduled runs, and event-triggered runs (formerly `recipe_runs` — renamed
 * because chat and workflow rows were never recipes). `skill_id` is nullable:
 * chat turns have no skill.
 */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").references(() => skills.id, {
      onDelete: "set null",
    }),
    skillSlug: text("skill_slug"),
    /** Which schedule occurrence produced this run; null for ad-hoc runs. */
    scheduleId: uuid("schedule_id").references(() => schedules.id, {
      onDelete: "set null",
    }),
    eventTriggerId: uuid("event_trigger_id").references(() => eventTriggers.id, {
      onDelete: "set null",
    }),
    eventDeliveryId: text("event_delivery_id"),
    threadId: uuid("thread_id").references(() => chatThreads.id, {
      onDelete: "set null",
    }),
    triggerType: text("trigger_type").notNull().default("manual"),
    status: runStatusEnum("status").notNull().default("queued"),
    runtime: text("runtime"),
    modelId: text("model_id"),
    inputs: jsonb("inputs"),
    outputs: jsonb("outputs"),
    error: text("error"),
    workerId: text("worker_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
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
    userIdx: index("runs_user_idx").on(t.userId, sql`${t.createdAt} DESC`),
    statusIdx: index("runs_status_idx").on(t.status),
    workerClaimIdx: index("runs_worker_claim_idx").on(
      t.status,
      t.leaseExpiresAt,
      t.createdAt,
    ),
    skillIdx: index("runs_skill_idx").on(t.skillId),
    threadIdx: index("runs_thread_idx").on(t.threadId),
    scheduleIdx: index("runs_schedule_idx").on(t.scheduleId),
    eventTriggerIdx: index("runs_event_trigger_idx").on(t.eventTriggerId),
    eventDeliveryUnique: uniqueIndex("runs_event_delivery_idx")
      .on(t.eventTriggerId, t.eventDeliveryId)
      .where(sql`${t.eventTriggerId} IS NOT NULL AND ${t.eventDeliveryId} IS NOT NULL`),
  }),
);

/**
 * Durable webhook receipt. The unique trigger/delivery pair is claimed before
 * enqueueing, so concurrent GitHub retries cannot create duplicate runs.
 */
export const eventTriggerDeliveries = pgTable(
  "event_trigger_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    triggerId: uuid("trigger_id")
      .notNull()
      .references(() => eventTriggers.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    source: text("source").notNull(),
    deliveryId: text("delivery_id").notNull(),
    eventType: text("event_type").notNull(),
    eventAction: text("event_action"),
    repository: text("repository").notNull(),
    eventSummary: text("event_summary").notNull(),
    status: text("status").notNull().default("claimed"),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    triggerDeliveryUnique: uniqueIndex(
      "event_trigger_deliveries_trigger_delivery_idx",
    ).on(t.triggerId, t.deliveryId),
    runIdx: index("event_trigger_deliveries_run_idx").on(t.runId),
    receivedIdx: index("event_trigger_deliveries_received_idx").on(t.receivedAt),
  }),
);

/**
 * Append-only, reloadable activity stream for durable runs. `runs` is the
 * generalized run ledger; this table holds the ordered human-facing progress
 * events that can be replayed after reconnect.
 */
export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    status: text("status").notNull().default("info"),
    label: text("label").notNull(),
    provider: text("provider"),
    toolName: text("tool_name"),
    toolCallId: text("tool_call_id"),
    input: jsonb("input"),
    output: jsonb("output"),
    error: text("error"),
    metadata: jsonb("metadata"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    runIdx: index("run_events_run_idx").on(t.runId, t.sequence, t.occurredAt),
    // #443: dual writers racing read-max-then-insert must collide (23505)
    // instead of corrupting replay order; the append helper retries on it.
    runSequenceUnique: uniqueIndex("run_events_run_sequence_unique_idx").on(
      t.runId,
      t.sequence,
    ),
    typeIdx: index("run_events_type_idx").on(t.eventType),
    toolCallIdx: index("run_events_tool_call_idx").on(t.toolCallId),
  }),
);

/**
 * Per-user notification inbox (issue #292). Written by the chat-run worker
 * when a scheduled or event-triggered run reaches a terminal status; read by
 * the bell/center in the app shell. Strictly per-user — queries scope with
 * `eq(userId, caller)`,
 * never an admin bypass. `run_id` is unique so worker retries can never
 * produce a duplicate notification for the same run. `accepted_at` is the
 * north-star signal: set the first time the user opens the notification's
 * run output ("accepted proactive work").
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "run_succeeded" | "run_failed" — failure renders distinguishably. */
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    /** Deep-link target: the thread the run's output landed in. */
    threadId: uuid("thread_id").references(() => chatThreads.id, {
      onDelete: "set null",
    }),
    readAt: timestamp("read_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index("notifications_user_idx").on(
      t.userId,
      sql`${t.createdAt} DESC`,
    ),
    /** Multiple NULLs allowed; non-null run ids are one-notification-per-run. */
    runUnique: uniqueIndex("notifications_run_idx").on(t.runId),
  }),
);

/**
 * Transcript windows waiting for the background Vault-memory reviewer. The
 * source chat messages remain the source of truth; these rows only say which
 * completed turn should be considered for memory extraction.
 */
export const memoryCaptureQueue = pgTable(
  "memory_capture_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    fromMessageId: uuid("from_message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    toMessageId: uuid("to_message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    reason: text("reason").notNull().default("chat_turn"),
    status: memoryCaptureStatusEnum("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    error: text("error"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userStatusIdx: index("memory_capture_queue_user_status_idx").on(
      t.userId,
      t.status,
      t.createdAt,
    ),
    threadIdx: index("memory_capture_queue_thread_idx").on(
      t.threadId,
      t.createdAt,
    ),
    /** #462: the chat_messages FKs cascade on delete; without these a thread
     * delete walks the whole queue once per message. */
    fromMessageIdx: index("memory_capture_queue_from_message_idx").on(
      t.fromMessageId,
    ),
    toMessageIdx: index("memory_capture_queue_to_message_idx").on(
      t.toMessageId,
    ),
    /** #462: worker claim scan — status filter ordered by age, no user filter. */
    statusCreatedIdx: index("memory_capture_queue_status_created_idx").on(
      t.status,
      t.createdAt,
    ),
    runUnique: uniqueIndex("memory_capture_queue_run_idx").on(t.runId),
  }),
);

/**
 * Reviewable personal context records shown in Vault. `approved` items render
 * into the user's Vault markdown and can be injected into future turns;
 * `suggested` items wait for explicit user approval.
 */
export const userMemoryItems = pgTable(
  "user_memory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: userMemoryStatusEnum("status").notNull().default("suggested"),
    category: text("category").notNull(),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull(),
    confidence: integer("confidence").notNull().default(0),
    reason: text("reason"),
    sourceThreadId: uuid("source_thread_id").references(() => chatThreads.id, {
      onDelete: "set null",
    }),
    sourceMessageIds: jsonb("source_message_ids").$type<string[]>(),
    suggestedBy: text("suggested_by").notNull().default("memory-capture"),
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userStatusIdx: index("user_memory_items_user_status_idx").on(
      t.userId,
      t.status,
      t.updatedAt,
    ),
    userCategoryIdx: index("user_memory_items_user_category_idx").on(
      t.userId,
      t.category,
      t.status,
    ),
    sourceThreadIdx: index("user_memory_items_source_thread_idx").on(
      t.sourceThreadId,
    ),
  }),
);

/**
 * User-visible files produced by chat runs. Content is stored in Postgres for
 * the first product pass so artifacts survive container restarts and remain
 * scoped to the owning user; large binary/object storage can replace `content`
 * later without changing the chat surface.
 */
export const workspaceArtifacts = pgTable(
  "workspace_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").references(() => chatThreads.id, {
      onDelete: "set null",
    }),
    chatMessageId: uuid("chat_message_id").references(() => chatMessages.id, {
      onDelete: "set null",
    }),
    runId: uuid("run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    filename: text("filename").notNull(),
    /**
     * Native artifact versioning. Every artifact belongs to a stable logical
     * group; the group id is the first version's id for backfilled rows and a
     * generated id for new groups. Revisions append immutable rows with a
     * higher version_number instead of overwriting content.
     */
    artifactGroupId: uuid("artifact_group_id").notNull().defaultRandom(),
    versionNumber: integer("version_number").notNull().default(1),
    supersedesArtifactId: uuid("supersedes_artifact_id").references(
      (): AnyPgColumn => workspaceArtifacts.id,
      { onDelete: "set null" },
    ),
    versionSummary: text("version_summary"),
    kind: text("kind").notNull().default("file"),
    mimeType: text("mime_type").notNull().default("text/plain"),
    content: text("content").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    source: text("source").notNull().default("assistant"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index("workspace_artifacts_user_created_idx").on(
      t.userId,
      sql`${t.createdAt} DESC`,
    ),
    threadIdx: index("workspace_artifacts_thread_idx").on(t.threadId),
    messageIdx: index("workspace_artifacts_message_idx").on(t.chatMessageId),
    runIdx: index("workspace_artifacts_run_idx").on(t.runId),
    groupIdx: index("workspace_artifacts_group_idx").on(
      t.userId,
      t.artifactGroupId,
      t.versionNumber,
    ),
    groupVersionUnique: uniqueIndex(
      "workspace_artifacts_group_version_idx",
    ).on(t.userId, t.artifactGroupId, t.versionNumber),
    messageFilenameUnique: uniqueIndex(
      "workspace_artifacts_message_filename_idx",
    ).on(t.chatMessageId, t.filename),
  }),
);

/**
 * Review comments are pinned to one immutable artifact version. Snapshot
 * columns keep a deleted version visibly unavailable instead of silently
 * moving its feedback to a newer file. `revision` fences concurrent edits and
 * `addressing_run_id` reserves exactly the comments included in one scoped
 * Comparative follow-up.
 */
export const artifactReviewComments = pgTable(
  "artifact_review_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: uuid("artifact_id").references(() => workspaceArtifacts.id, {
      onDelete: "set null",
    }),
    artifactOwnerUserId: uuid("artifact_owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    artifactGroupId: uuid("artifact_group_id").notNull(),
    artifactVersionNumber: integer("artifact_version_number").notNull(),
    artifactFilename: text("artifact_filename").notNull(),
    threadId: uuid("thread_id").references(() => chatThreads.id, {
      onDelete: "set null",
    }),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    authorDisplayName: text("author_display_name").notNull(),
    body: text("body").notNull(),
    anchor: jsonb("anchor").notNull(),
    status: artifactReviewCommentStatusEnum("status")
      .notNull()
      .default("open"),
    revision: integer("revision").notNull().default(1),
    addressingRunId: uuid("addressing_run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    addressedByUserId: uuid("addressed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    addressedAt: timestamp("addressed_at", { withTimezone: true }),
    resultArtifactId: uuid("result_artifact_id").references(
      () => workspaceArtifacts.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    artifactStatusCreatedIdx: index(
      "artifact_review_comments_artifact_status_created_idx",
    ).on(t.artifactId, t.status, t.createdAt),
    versionCreatedIdx: index(
      "artifact_review_comments_version_created_idx",
    ).on(
      t.artifactOwnerUserId,
      t.artifactGroupId,
      t.artifactVersionNumber,
      t.createdAt,
    ),
    authorCreatedIdx: index(
      "artifact_review_comments_author_created_idx",
    ).on(t.authorUserId, t.createdAt),
    addressingRunIdx: index(
      "artifact_review_comments_addressing_run_idx",
    ).on(t.addressingRunId),
    resultArtifactIdx: index(
      "artifact_review_comments_result_artifact_idx",
    ).on(t.resultArtifactId),
  }),
);

/**
 * Lightweight, dismissible suggestions generated from user/job context and
 * recent work. These stay explicit: Comparative can recommend a tool, skill,
 * app, or schedule, but acceptance is always user-driven and audited through
 * this state row.
 */
export const recommendations = pgTable(
  "recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").references(() => chatThreads.id, {
      onDelete: "cascade",
    }),
    chatMessageId: uuid("chat_message_id").references(() => chatMessages.id, {
      onDelete: "cascade",
    }),
    runId: uuid("run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("suggested"),
    action: jsonb("action").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userStatusIdx: index("recommendations_user_status_idx").on(
      t.userId,
      t.status,
      sql`${t.createdAt} DESC`,
    ),
    messageIdx: index("recommendations_message_idx").on(t.chatMessageId),
    runIdx: index("recommendations_run_idx").on(t.runId),
  }),
);

/**
 * In-product feedback reports from alpha testers and early enterprise users.
 * Reports keep the user-written issue plus lightweight product context so an
 * admin can triage without asking the tester to manually export every chat.
 */
export const feedbackReports = pgTable(
  "feedback_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").references(() => chatThreads.id, {
      onDelete: "set null",
    }),
    chatMessageId: uuid("chat_message_id").references(() => chatMessages.id, {
      onDelete: "set null",
    }),
    runId: uuid("run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    artifactId: uuid("artifact_id").references(() => workspaceArtifacts.id, {
      onDelete: "set null",
    }),
    type: text("report_type").notNull().default("bug"),
    severity: text("severity").notNull().default("normal"),
    status: text("status").notNull().default("new"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    expected: text("expected"),
    pageUrl: text("page_url"),
    userAgent: text("user_agent"),
    viewport: jsonb("viewport").$type<Record<string, unknown>>(),
    context: jsonb("context").$type<Record<string, unknown>>(),
    screenshotDataUrl: text("screenshot_data_url"),
    screenshotName: text("screenshot_name"),
    screenshotMimeType: text("screenshot_mime_type"),
    linkedIssueUrl: text("linked_issue_url"),
    adminNotes: text("admin_notes"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusCreatedIdx: index("feedback_reports_status_created_idx").on(
      t.status,
      sql`${t.createdAt} DESC`,
    ),
    userCreatedIdx: index("feedback_reports_user_created_idx").on(
      t.userId,
      sql`${t.createdAt} DESC`,
    ),
    threadIdx: index("feedback_reports_thread_idx").on(t.threadId),
  }),
);

/**
 * Generic grant — the J5 "make this available to Alice" seed, shared by
 * skills and apps. A share grants visibility + run/open + clone, never edit
 * and never the grantor's credentials: every execution re-gates on the
 * recipient's own oauth_tokens and user_tool_attestations.
 */
export const shares = pgTable(
  "shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** "skill" | "app" — polymorphic subject, FK enforced in app layer. */
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    grantedToUserId: uuid("granted_to_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedByUserId: uuid("granted_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * App shares use viewer/editor roles. Skill shares ignore this for now and
     * keep the default viewer role.
     */
    role: text("role").notNull().default("viewer"),
    /** Revocation hides the subject; recipient clones are unaffected. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    activeGrantUnique: uniqueIndex("shares_active_grant_idx")
      .on(t.subjectType, t.subjectId, t.grantedToUserId)
      .where(sql`${t.revokedAt} IS NULL`),
    subjectIdx: index("shares_subject_idx").on(t.subjectType, t.subjectId),
    granteeIdx: index("shares_grantee_idx").on(
      t.grantedToUserId,
      t.subjectType,
    ),
  }),
);

/**
 * Registry for thin deployed apps (J4 slice). Versions are workspace
 * artifacts; "Deploy" pins `live_artifact_id`, "Save draft" appends a new
 * artifact version, revert repins an older one. Apps are served at
 * /apps/{slug} behind workspace auth with a restrictive CSP — no git,
 * pipelines, or per-app AWS services in this slice.
 */
export const apps = pgTable(
  "apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Currently deployed artifact version; NULL = draft-only. */
    liveArtifactId: uuid("live_artifact_id").references(
      () => workspaceArtifacts.id,
      { onDelete: "set null" },
    ),
    /** Target app lifecycle pointer. Kept nullable during live_artifact_id migration. */
    liveVersionId: uuid("live_version_id").references(
      (): AnyPgColumn => appVersions.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull().default("draft"),
    /** Where it was built — "open the conversation behind this app". */
    sourceThreadId: uuid("source_thread_id").references(() => chatThreads.id, {
      onDelete: "set null",
    }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    slugUnique: uniqueIndex("apps_slug_idx").on(t.slug),
    ownerIdx: index("apps_owner_idx").on(t.ownerUserId),
    liveVersionIdx: index("apps_live_version_idx").on(t.liveVersionId),
  }),
);

/**
 * Durable lifecycle rows for thin apps. Workspace artifacts still hold the
 * immutable HTML bytes; app_versions assigns app-specific version numbers,
 * draft/live status, and deployment metadata.
 */
export const appVersions = pgTable(
  "app_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => workspaceArtifacts.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    status: text("status").notNull().default("draft"),
    summary: text("summary"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceThreadId: uuid("source_thread_id").references(() => chatThreads.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deployedAt: timestamp("deployed_at", { withTimezone: true }),
  },
  (t) => ({
    appVersionUnique: uniqueIndex("app_versions_app_version_idx").on(
      t.appId,
      t.versionNumber,
    ),
    appArtifactUnique: uniqueIndex("app_versions_app_artifact_idx").on(
      t.appId,
      t.artifactId,
    ),
    appStatusIdx: index("app_versions_app_status_idx").on(t.appId, t.status),
    appCreatedIdx: index("app_versions_app_created_idx").on(
      t.appId,
      sql`${t.createdAt} DESC`,
    ),
  }),
);

/**
 * App-scoped editing sessions. They bind a chat thread to the app/version the
 * user is editing so runtime context can load the right app bytes every turn.
 */
export const appEditSessions = pgTable(
  "app_edit_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    baseVersionId: uuid("base_version_id")
      .notNull()
      .references(() => appVersions.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    appStatusIdx: index("app_edit_sessions_app_status_idx").on(
      t.appId,
      t.status,
    ),
    threadUnique: uniqueIndex("app_edit_sessions_thread_idx").on(t.threadId),
    actorActiveIdx: index("app_edit_sessions_actor_active_idx").on(
      t.createdByUserId,
      t.status,
    ),
  }),
);

/**
 * Immutable branch-point snapshots for alternate approaches. The child thread
 * owns its copied message text; live foreign keys are retained only so current
 * authorization can be rechecked. Snapshot ids preserve provenance after a
 * source thread, message, artifact, or app version is deleted.
 */
export const chatThreadBranches = pgTable(
  "chat_thread_branches",
  {
    threadId: uuid("thread_id")
      .primaryKey()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    parentThreadId: uuid("parent_thread_id").references(
      () => chatThreads.id,
      { onDelete: "set null" },
    ),
    parentThreadIdSnapshot: uuid("parent_thread_id_snapshot"),
    branchPointMessageId: uuid("branch_point_message_id").references(
      () => chatMessages.id,
      { onDelete: "set null" },
    ),
    branchPointMessageIdSnapshot: uuid("branch_point_message_id_snapshot"),
    sourceType: chatThreadBranchSourceTypeEnum("source_type").notNull(),
    sourceArtifactId: uuid("source_artifact_id").references(
      () => workspaceArtifacts.id,
      { onDelete: "set null" },
    ),
    sourceArtifactIdSnapshot: uuid("source_artifact_id_snapshot"),
    sourceAppVersionId: uuid("source_app_version_id").references(
      () => appVersions.id,
      { onDelete: "set null" },
    ),
    sourceAppVersionIdSnapshot: uuid("source_app_version_id_snapshot"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    snapshot: jsonb("snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    parentIdx: index("chat_thread_branches_parent_idx").on(
      t.parentThreadId,
      t.createdAt,
    ),
    branchPointIdx: index("chat_thread_branches_point_idx").on(
      t.branchPointMessageId,
    ),
    sourceArtifactIdx: index("chat_thread_branches_artifact_idx").on(
      t.sourceArtifactId,
    ),
    sourceAppVersionIdx: index("chat_thread_branches_app_version_idx").on(
      t.sourceAppVersionId,
    ),
    actorIdx: index("chat_thread_branches_actor_idx").on(
      t.createdByUserId,
      t.createdAt,
    ),
  }),
);

/**
 * Shared fixed-window request-limit buckets. These replace the old
 * process-local Map so multiple ECS web tasks enforce one consistent quota
 * per logical key (for example `chat:<user-id>`).
 */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    bucketKey: text("bucket_key").primaryKey(),
    count: integer("count").notNull().default(0),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    resetIdx: index("rate_limit_buckets_reset_idx").on(t.resetAt),
  }),
);

/**
 * Admin-curated registry of MCP servers AI Hub can mount. Provider slugs stay
 * stable across OAuth, catalog, attestation, and runtime code.
 */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    transport: mcpServerTransportEnum("transport").notNull(),
    status: mcpServerStatusEnum("status").notNull().default("active"),
    endpointUrl: text("endpoint_url"),
    authMode: text("auth_mode"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    slugUnique: uniqueIndex("mcp_servers_slug_idx").on(t.slug),
    statusIdx: index("mcp_servers_status_idx").on(t.status),
    transportIdx: index("mcp_servers_transport_idx").on(t.transport),
  }),
);

/**
 * Admin-curated catalog of user-visible tools exposed through MCP providers.
 * The provider + provider-native tool name remains the stable lookup key; the
 * optional MCP server FK links catalog rows to the admin registry.
 */
export const toolsCatalog = pgTable(
  "tools_catalog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mcpServerId: uuid("mcp_server_id").references(() => mcpServers.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(),
    toolName: text("tool_name").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    category: text("category").notNull().default("general"),
    action: toolCatalogActionEnum("action").notNull().default("read"),
    requiresAttestation: boolean("requires_attestation")
      .notNull()
      .default(true),
    enabled: boolean("enabled").notNull().default(true),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    providerToolUnique: uniqueIndex("tools_catalog_provider_tool_idx").on(
      t.provider,
      t.toolName,
    ),
    providerIdx: index("tools_catalog_provider_idx").on(t.provider),
    categoryIdx: index("tools_catalog_category_idx").on(t.category),
    enabledIdx: index("tools_catalog_enabled_idx").on(t.enabled),
    mcpServerIdx: index("tools_catalog_mcp_server_idx").on(t.mcpServerId),
  }),
);

/**
 * User approvals for provider, category, or individual-tool access. Runtime
 * enforcement lands later, but this table gives the policy layer an explicit
 * source of truth and preserves approval/revocation history.
 */
export const userToolAttestations = pgTable(
  "user_tool_attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopeType: userToolAttestationScopeEnum("scope_type").notNull(),
    provider: text("provider").notNull(),
    category: text("category"),
    toolCatalogId: uuid("tool_catalog_id").references(() => toolsCatalog.id, {
      onDelete: "set null",
    }),
    toolName: text("tool_name"),
    action: toolCatalogActionEnum("action").notNull().default("read"),
    approvedAt: timestamp("approved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reason: text("reason"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userActiveIdx: index("user_tool_attestations_user_active_idx").on(
      t.userId,
      t.revokedAt,
    ),
    userProviderIdx: index("user_tool_attestations_user_provider_idx").on(
      t.userId,
      t.provider,
    ),
    userCategoryIdx: index("user_tool_attestations_user_category_idx").on(
      t.userId,
      t.provider,
      t.category,
    ),
    userToolIdx: index("user_tool_attestations_user_tool_idx").on(
      t.userId,
      t.provider,
      t.toolName,
    ),
    toolCatalogIdx: index("user_tool_attestations_tool_catalog_idx").on(
      t.toolCatalogId,
    ),
  }),
);

/**
 * Central append-only audit ledger. MCP tool executions write here from the
 * chat route; later PRs can use the same shape for admin, auth, and security
 * events. The foreign keys are nullable so retention/deletion of user-facing
 * artifacts does not erase the compliance trail.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actionType: text("action_type").notNull(),
    status: auditLogStatusEnum("status").notNull(),
    provider: text("provider"),
    toolName: text("tool_name"),
    toolCallId: text("tool_call_id"),
    chatThreadId: uuid("chat_thread_id").references(() => chatThreads.id, {
      onDelete: "set null",
    }),
    chatMessageId: uuid("chat_message_id").references(() => chatMessages.id, {
      onDelete: "set null",
    }),
    runId: uuid("run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    input: jsonb("input"),
    output: jsonb("output"),
    error: text("error"),
    metadata: jsonb("metadata"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    actorIdx: index("audit_log_actor_idx").on(
      t.actorUserId,
      sql`${t.createdAt} DESC`,
    ),
    actionIdx: index("audit_log_action_idx").on(
      t.actionType,
      sql`${t.createdAt} DESC`,
    ),
    statusIdx: index("audit_log_status_idx").on(t.status),
    providerToolIdx: index("audit_log_provider_tool_idx").on(
      t.provider,
      t.toolName,
    ),
    chatMessageIdx: index("audit_log_chat_message_idx").on(t.chatMessageId),
    runIdx: index("audit_log_run_idx").on(t.runId),
  }),
);

/**
 * Short-lived, user-owned AgentCore Browser sessions used by Contribution
 * Studio. Provider identifiers are never accepted as authorization: every API
 * lookup also matches the owning user and thread.
 */
export const studioBrowserSessions = pgTable(
  "studio_browser_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    providerSessionId: text("provider_session_id").notNull(),
    browserIdentifier: text("browser_identifier").notNull(),
    targetKind: text("target_kind").notNull(),
    targetResourceId: text("target_resource_id"),
    displayUrl: text("display_url").notNull(),
    origin: text("origin").notNull(),
    status: text("status").notNull().default("starting"),
    viewportWidth: integer("viewport_width").notNull().default(1440),
    viewportHeight: integer("viewport_height").notNull().default(900),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    lastError: text("last_error"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    providerSessionUnique: uniqueIndex(
      "studio_browser_sessions_provider_session_idx",
    ).on(t.providerSessionId),
    activeUserThreadUnique: uniqueIndex(
      "studio_browser_sessions_active_user_thread_idx",
    )
      .on(t.userId, t.threadId)
      .where(sql`${t.status} IN ('starting', 'ready')`),
    userCreatedIdx: index("studio_browser_sessions_user_created_idx").on(
      t.userId,
      sql`${t.createdAt} DESC`,
    ),
    threadCreatedIdx: index("studio_browser_sessions_thread_created_idx").on(
      t.threadId,
      sql`${t.createdAt} DESC`,
    ),
    statusExpiryIdx: index("studio_browser_sessions_status_expiry_idx").on(
      t.status,
      t.expiresAt,
    ),
  }),
);

/**
 * Server-registered task sandbox endpoints. No public route writes these rows;
 * a sandbox runtime records its VPC hostname and explicit loopback port set,
 * then Studio can mint one short-lived grant for an owned endpoint.
 */
export const studioSandboxEndpoints = pgTable(
  "studio_sandbox_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    allowedPorts: jsonb("allowed_ports").$type<number[]>().notNull(),
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userThreadIdx: index("studio_sandbox_endpoints_user_thread_idx").on(
      t.userId,
      t.threadId,
      t.status,
    ),
    expiryIdx: index("studio_sandbox_endpoints_expiry_idx").on(t.expiresAt),
  }),
);

/**
 * Expiring bearer grants used only by the isolated browser to read one
 * Comparative-owned artifact/app target. Raw tokens are never persisted.
 */
export const studioBrowserGrants = pgTable(
  "studio_browser_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    browserSessionId: uuid("browser_session_id")
      .notNull()
      .references(() => studioBrowserSessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    targetKind: text("target_kind").notNull(),
    targetResourceId: text("target_resource_id").notNull(),
    targetPath: text("target_path").notNull(),
    sandboxPort: integer("sandbox_port"),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex("studio_browser_grants_token_hash_idx").on(
      t.tokenHash,
    ),
    sessionIdx: index("studio_browser_grants_session_idx").on(
      t.browserSessionId,
      t.expiresAt,
    ),
    userThreadIdx: index("studio_browser_grants_user_thread_idx").on(
      t.userId,
      t.threadId,
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
export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
export type Schedule = typeof schedules.$inferSelect;
export type NewSchedule = typeof schedules.$inferInsert;
export type EventTrigger = typeof eventTriggers.$inferSelect;
export type NewEventTrigger = typeof eventTriggers.$inferInsert;
export type EventTriggerDelivery = typeof eventTriggerDeliveries.$inferSelect;
export type NewEventTriggerDelivery = typeof eventTriggerDeliveries.$inferInsert;
export type Share = typeof shares.$inferSelect;
export type NewShare = typeof shares.$inferInsert;
export type App = typeof apps.$inferSelect;
export type NewApp = typeof apps.$inferInsert;
export type AppVersion = typeof appVersions.$inferSelect;
export type NewAppVersion = typeof appVersions.$inferInsert;
export type AppEditSession = typeof appEditSessions.$inferSelect;
export type NewAppEditSession = typeof appEditSessions.$inferInsert;
export type ChatThreadBranch = typeof chatThreadBranches.$inferSelect;
export type NewChatThreadBranch = typeof chatThreadBranches.$inferInsert;
export type RunEvent = typeof runEvents.$inferSelect;
export type NewRunEvent = typeof runEvents.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type ModelEnablement = typeof modelEnablement.$inferSelect;
export type NewModelEnablement = typeof modelEnablement.$inferInsert;
export type MemoryCaptureQueueItem = typeof memoryCaptureQueue.$inferSelect;
export type NewMemoryCaptureQueueItem = typeof memoryCaptureQueue.$inferInsert;
export type UserMemoryItem = typeof userMemoryItems.$inferSelect;
export type NewUserMemoryItem = typeof userMemoryItems.$inferInsert;
export type WorkspaceArtifact = typeof workspaceArtifacts.$inferSelect;
export type NewWorkspaceArtifact = typeof workspaceArtifacts.$inferInsert;
export type ArtifactReviewComment =
  typeof artifactReviewComments.$inferSelect;
export type NewArtifactReviewComment =
  typeof artifactReviewComments.$inferInsert;
export type Recommendation = typeof recommendations.$inferSelect;
export type NewRecommendation = typeof recommendations.$inferInsert;
export type FeedbackReport = typeof feedbackReports.$inferSelect;
export type NewFeedbackReport = typeof feedbackReports.$inferInsert;
export type McpServer = typeof mcpServers.$inferSelect;
export type NewMcpServer = typeof mcpServers.$inferInsert;
export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
export type StudioBrowserSession = typeof studioBrowserSessions.$inferSelect;
export type NewStudioBrowserSession = typeof studioBrowserSessions.$inferInsert;
export type StudioBrowserGrant = typeof studioBrowserGrants.$inferSelect;
export type NewStudioBrowserGrant = typeof studioBrowserGrants.$inferInsert;
export type StudioSandboxEndpoint = typeof studioSandboxEndpoints.$inferSelect;
export type NewStudioSandboxEndpoint =
  typeof studioSandboxEndpoints.$inferInsert;
export type ToolCatalogEntry = typeof toolsCatalog.$inferSelect;
export type NewToolCatalogEntry = typeof toolsCatalog.$inferInsert;
export type UserToolAttestation = typeof userToolAttestations.$inferSelect;
export type NewUserToolAttestation = typeof userToolAttestations.$inferInsert;
