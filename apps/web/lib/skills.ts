import type { SessionUser } from "@ai-workspace/auth";
import {
  auditLog,
  chatMessages,
  chatThreads,
  type Database,
  runs,
  type Skill,
  skills,
} from "@ai-workspace/db";
import { DEFAULT_MODEL_ID, isValidModelId } from "@ai-workspace/agent";
import { startInProcessChatRunWorker } from "@/lib/chat-run-worker";
import { isModelEnabled, resolveModelForPurpose } from "@/lib/model-registry";
import {
  loadUserMcpProviderStatus,
  SUPPORTED_MCP_PROVIDERS,
} from "@/lib/oauth/mcp-servers";
import { appendRunEventWithNextSequence } from "@/lib/run-events";
import {
  SKILL_WEB_ACCESS_DECLARATION,
  skillMcpProviders,
} from "@/lib/skill-tool-declarations";
import type { ScheduleFire } from "@/lib/run-status-presentation";
import { canonicalizeStarterSkill } from "@/lib/starter-skills";
import { resolveAutonomyPreset } from "@/lib/autonomy-presets";
import {
  resolveNewRunBudget,
  runBudgetEnvelopeForEvent,
} from "@/lib/run-budget-policy";

export interface SkillInput {
  name: string;
  description: string | null;
  systemPrompt: string;
  modelId: string;
  mcpProviders: string[];
}

export interface SkillValidationError {
  field: string;
  message: string;
}

const NAME_MAX = 120;
const DESCRIPTION_MAX = 2_000;
const PROMPT_MAX = 20_000;

/**
 * Validate and normalize a create/update payload. Returns either the
 * normalized input or a field-level error suitable for a 400 response.
 */
export function parseSkillInput(
  value: unknown,
  options: {
    /**
     * Chat-enabled model ids from the registry (#300). When provided, a
     * disabled model cannot be pinned to a skill. Omitted = validity-only
     * (registry membership) for callers without a db handle.
     */
    enabledModelIds?: ReadonlySet<string>;
  } = {},
): { ok: true; input: SkillInput } | { ok: false; error: SkillValidationError } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: { field: "body", message: "Request body must be a JSON object." },
    };
  }
  const body = value as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > NAME_MAX) {
    return {
      ok: false,
      error: {
        field: "name",
        message: `Name is required and must be at most ${NAME_MAX} characters.`,
      },
    };
  }

  const description =
    typeof body.description === "string" && body.description.trim()
      ? body.description.trim().slice(0, DESCRIPTION_MAX)
      : null;

  const systemPrompt =
    typeof body.systemPrompt === "string" ? body.systemPrompt.trim() : "";
  if (!systemPrompt || systemPrompt.length > PROMPT_MAX) {
    return {
      ok: false,
      error: {
        field: "systemPrompt",
        message: `Instructions are required and must be at most ${PROMPT_MAX} characters.`,
      },
    };
  }

  const modelId =
    typeof body.modelId === "string" && body.modelId
      ? body.modelId
      : DEFAULT_MODEL_ID;
  if (!isValidModelId(modelId)) {
    return {
      ok: false,
      error: { field: "modelId", message: "Unknown model id." },
    };
  }
  if (options.enabledModelIds && !options.enabledModelIds.has(modelId)) {
    return {
      ok: false,
      error: {
        field: "modelId",
        message: "Model is not enabled for skills.",
      },
    };
  }

  const rawProviders = Array.isArray(body.mcpProviders)
    ? body.mcpProviders
    : [];
  const mcpProviders = [
    ...new Set(
      rawProviders.filter((p): p is string => typeof p === "string" && !!p),
    ),
  ];
  const unsupported = mcpProviders.filter(
    (p) =>
      p !== SKILL_WEB_ACCESS_DECLARATION &&
      !SUPPORTED_MCP_PROVIDERS.includes(p),
  );
  if (unsupported.length > 0) {
    return {
      ok: false,
      error: {
        field: "mcpProviders",
        message: `Unsupported tool provider(s): ${unsupported.join(", ")}.`,
      },
    };
  }

  return {
    ok: true,
    input: { name, description, systemPrompt, modelId, mcpProviders },
  };
}

/** URL-safe slug from a skill name; caller handles uniqueness. */
export function slugifySkillName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "skill";
}

/** Slug with a short random suffix for collision retries. */
export function suffixedSkillSlug(base: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base}-${suffix}`;
}

/**
 * Visibility: owners always see their skills; starters are visible to
 * everyone; admins see everything. Archived skills stay visible to their
 * owner (and admins) so history links keep working, but are never runnable.
 */
export function canViewSkill(
  skill: Pick<Skill, "ownerUserId" | "isStarter" | "archivedAt">,
  actor: Pick<SessionUser, "id" | "role">,
): boolean {
  if (skill.ownerUserId === actor.id) return true;
  if (actor.role === "admin") return true;
  return skill.isStarter && !skill.archivedAt;
}

export function canRunSkill(
  skill: Pick<Skill, "ownerUserId" | "isStarter" | "archivedAt">,
  actor: Pick<SessionUser, "id" | "role">,
): boolean {
  return canViewSkill(skill, actor) && !skill.archivedAt;
}

/**
 * The skill's instructions become the turn's user message; the existing
 * worker pipeline (context build, MCP mount, audit, artifacts, timeline)
 * handles everything downstream exactly like a chat turn.
 */
export function buildSkillTurnPrompt(
  skill: Pick<Skill, "name" | "systemPrompt">,
): string {
  return [
    `You are running the saved skill "${skill.name}".`,
    "Follow these instructions and produce the result directly in this thread:",
    "",
    skill.systemPrompt,
  ].join("\n");
}

/**
 * The model-visible user message for an explicit skill activation (#416).
 * The skill's operating instructions no longer ride here — they pin into
 * the stable system prefix via the context pack (`renderPinnedActiveSkill`),
 * where a future summarizer cannot rewrite or drop them. Only the user's
 * own request remains in the summarizable message stream.
 */
export function buildActivatedSkillUserMessage(userRequest: string): string {
  return (
    userRequest.trim() ||
    "Run this skill using the available conversation context."
  );
}

export function buildSkillDisplayMessage(skill: Pick<Skill, "name">): string {
  return `Run ${skill.name}`;
}

export interface SkillProviderAccess {
  /** Declared providers the user has connected and attested. */
  ready: string[];
  /** Declared providers with no connected OAuth token. */
  missingConnections: string[];
  /** Declared providers connected but lacking an active attestation. */
  deniedAttestations: string[];
  /** Declared providers connected and attested but not executable here. */
  executionUnavailable: string[];
  /** Declared providers whose existing OAuth grant needs renewed scopes. */
  reconnectRequired: string[];
  /** Declared providers whose credentials could not be used temporarily. */
  temporarilyUnavailable: string[];
}

export function isSkillProviderAccessReady(
  access: SkillProviderAccess,
): boolean {
  return (
    access.missingConnections.length === 0 &&
    access.deniedAttestations.length === 0 &&
    access.executionUnavailable.length === 0 &&
    access.reconnectRequired.length === 0 &&
    access.temporarilyUnavailable.length === 0
  );
}

/**
 * FR-004: provider gating happens before any mount, with actionable
 * messaging. Always evaluated against the *executing* user — shares grant
 * visibility, never credentials.
 */
export async function checkSkillProviderAccess(
  db: Database,
  userId: string,
  declaredProviders: string[],
): Promise<SkillProviderAccess> {
  const mcpProviders = skillMcpProviders(declaredProviders);
  if (mcpProviders.length === 0) {
    return {
      ready: [],
      missingConnections: [],
      deniedAttestations: [],
      executionUnavailable: [],
      reconnectRequired: [],
      temporarilyUnavailable: [],
    };
  }

  const providerStatus = await loadUserMcpProviderStatus(db, userId, {
    onlyProviders: mcpProviders,
  });
  const connected = new Set(providerStatus.connectedProviders);
  const missingConnections = mcpProviders.filter(
    (p) => !connected.has(p),
  );
  const ready = mcpProviders.filter((p) =>
    providerStatus.allowedProviders.includes(p),
  );
  const deniedAttestations = mcpProviders.filter((p) =>
    providerStatus.deniedProviders.includes(p),
  );
  const executionUnavailable = mcpProviders.filter((p) =>
    (providerStatus.executionUnavailableProviders ?? []).includes(p),
  );
  const reconnectRequired = mcpProviders.filter((p) =>
    (providerStatus.reconnectRequiredProviders ?? []).includes(p),
  );
  const temporarilyUnavailable = mcpProviders.filter(
    (p) =>
      providerStatus.providerAvailability?.[p]?.status ===
      "temporarily_unavailable",
  );

  return {
    ready,
    missingConnections,
    deniedAttestations,
    executionUnavailable,
    reconnectRequired,
    temporarilyUnavailable,
  };
}

export interface CreateSkillRunResult {
  runId: string;
  threadId: string;
}

export interface GitHubSkillTriggerContext {
  triggerId: string;
  deliveryId: string;
  eventType: string;
  eventAction: string | null;
  repository: string;
  summary: string;
  promptContext: string;
}

const SAFE_GITHUB_REPOSITORY_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]{0,99})\/[a-z0-9](?:[a-z0-9._-]{0,99})$/i;

export function buildGitHubSkillDisplayMessage(
  event: Pick<GitHubSkillTriggerContext, "eventType" | "repository">,
): string {
  const repository = SAFE_GITHUB_REPOSITORY_PATTERN.test(event.repository)
    ? event.repository.toLowerCase()
    : "connected repository";
  const eventLabel =
    event.eventType === "pull_request_review"
      ? "pull request review"
      : event.eventType === "workflow_run"
        ? "failed CI workflow"
        : "repository event";
  return `GitHub event: ${eventLabel} in ${repository}`;
}

/**
 * Enqueue one execution of a skill on the shared worker pipeline. Used by
 * the run-now API (`triggerType: "skill"`) and the scheduler
 * (`triggerType: "scheduled"`, on cadence or from the schedule's "Run now"
 * action — `scheduleFire` records which, on the run's inputs/event/audit
 * metadata; #780). Creates the target thread when none is given, inserts the
 * materialized prompt as the user message, and queues a `runs` row whose
 * inputs satisfy the worker's chat-run contract.
 */
export async function createSkillRun({
  db,
  actorUserId,
  skill,
  triggerType,
  scheduleId,
  scheduleFire,
  githubEvent,
  threadId,
}: {
  db: Database;
  actorUserId: string;
  skill: Skill;
  triggerType: "skill" | "scheduled" | "github_event";
  scheduleId?: string | null;
  scheduleFire?: ScheduleFire;
  githubEvent?: GitHubSkillTriggerContext;
  threadId?: string | null;
}): Promise<CreateSkillRunResult> {
  skill = canonicalizeStarterSkill(skill);
  const now = new Date();
  if (triggerType === "github_event" && !githubEvent) {
    throw new Error("GitHub event context is required for an event-triggered run.");
  }
  const scheduleMarker = scheduleId
    ? { scheduleId, scheduleFire: scheduleFire ?? "cadence" }
    : {};

  // #300: a pinned model that has since been disabled for the durable lane
  // cannot serve the run — resolve to the enabled default instead.
  const runModelId = (await isModelEnabled(db, skill.modelId, "durable-local"))
    ? skill.modelId
    : await resolveModelForPurpose(db, "durable-local");

  let targetThreadId = threadId ?? null;
  if (!targetThreadId) {
    const threadRows = await db
      .insert(chatThreads)
      .values({
        userId: actorUserId,
        title: `Skill: ${skill.name}`,
        defaultModelId: runModelId,
        titleSource: "manual",
      })
      .returning({ id: chatThreads.id });
    targetThreadId = threadRows[0]!.id;
  }

  const prompt = githubEvent
    ? `${buildSkillTurnPrompt(skill)}\n\n${githubEvent.promptContext}`
    : buildSkillTurnPrompt(skill);
  const displayMessage = githubEvent
    ? buildGitHubSkillDisplayMessage(githubEvent)
    : buildSkillDisplayMessage(skill);
  const messageRows = await db
    .insert(chatMessages)
    .values({
      threadId: targetThreadId,
      role: "user",
      content: displayMessage,
    })
    .returning({ id: chatMessages.id });
  const userMessageId = messageRows[0]!.id;
  const runBudget = resolveNewRunBudget({
    lane: "durable-local",
    triggerType,
  });

  const runRows = await db
    .insert(runs)
    .values({
      userId: actorUserId,
      skillId: skill.id,
      skillSlug: skill.slug,
      scheduleId: scheduleId ?? null,
      eventTriggerId: githubEvent?.triggerId ?? null,
      eventDeliveryId: githubEvent?.deliveryId ?? null,
      threadId: targetThreadId,
      triggerType,
      status: "queued",
      modelId: runModelId,
      inputs: {
        prompt,
        threadId: targetThreadId,
        userMessageId,
        requestedByUserId: actorUserId,
        autonomyPreset: resolveAutonomyPreset(triggerType).name,
        executionMode: "local",
        requestedProviders: skill.mcpProviders,
        runBudget,
        skillId: skill.id,
        skillSlug: skill.slug,
        ...scheduleMarker,
        ...(githubEvent
          ? {
              eventTriggerId: githubEvent.triggerId,
              githubEvent: {
                deliveryId: githubEvent.deliveryId,
                eventType: githubEvent.eventType,
                eventAction: githubEvent.eventAction,
                repository: githubEvent.repository,
                summary: githubEvent.summary,
              },
            }
          : {}),
      },
      updatedAt: now,
    })
    .returning({ id: runs.id });
  const runId = runRows[0]!.id;

  await appendRunEventWithNextSequence({
    db,
    runId,
    eventType: "run_queued",
    status: "pending",
    label:
      triggerType === "scheduled"
        ? `Queued scheduled run of "${skill.name}"`
        : triggerType === "github_event"
          ? `Queued GitHub event run of "${skill.name}"`
        : `Queued skill run of "${skill.name}"`,
    metadata: {
      skillId: skill.id,
      skillSlug: skill.slug,
      threadId: targetThreadId,
      ...scheduleMarker,
      ...(githubEvent
        ? {
            eventTriggerId: githubEvent.triggerId,
            deliveryId: githubEvent.deliveryId,
            eventType: githubEvent.eventType,
            repository: githubEvent.repository,
          }
        : {}),
      runBudget: runBudgetEnvelopeForEvent(runBudget),
    },
  });

  await db.insert(auditLog).values({
    actorUserId,
    actionType:
      triggerType === "scheduled"
        ? "schedule_fire"
        : triggerType === "github_event"
          ? "event_trigger_fire"
          : "skill_run",
    status: "succeeded",
    provider: "ai-hub",
    toolName: skill.slug,
    chatThreadId: targetThreadId,
    runId,
    input: { skillId: skill.id, skillSlug: skill.slug },
    metadata: {
      modelId: runModelId,
      mcpProviders: skill.mcpProviders,
      triggerType,
      autonomyPreset: resolveAutonomyPreset(triggerType).name,
      runBudget: runBudgetEnvelopeForEvent(runBudget),
      ...scheduleMarker,
      ...(githubEvent
        ? {
            eventTriggerId: githubEvent.triggerId,
            deliveryId: githubEvent.deliveryId,
            eventType: githubEvent.eventType,
            eventAction: githubEvent.eventAction,
            repository: githubEvent.repository,
          }
        : {}),
    },
    startedAt: now,
    completedAt: now,
  });

  startInProcessChatRunWorker({ db, runId });

  return { runId, threadId: targetThreadId };
}

/** Audit helper for skill catalog mutations (create/update/clone/archive). */
export async function auditSkillMutation({
  db,
  actorUserId,
  actionType,
  skillId,
  skillSlug,
  metadata,
}: {
  db: Database;
  actorUserId: string;
  actionType:
    | "skill_create"
    | "skill_update"
    | "skill_clone"
    | "skill_archive"
    | "skill_seed";
  skillId: string;
  skillSlug: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  await db.insert(auditLog).values({
    actorUserId,
    actionType,
    status: "succeeded",
    provider: "ai-hub",
    toolName: skillSlug,
    input: { skillId, skillSlug },
    metadata: metadata ?? null,
    startedAt: now,
    completedAt: now,
  });
}

/** Insert a skill, retrying once with a suffixed slug on collision. */
export async function insertSkillWithUniqueSlug(
  db: Database,
  values: Omit<typeof skills.$inferInsert, "slug"> & { slug?: string },
): Promise<Skill> {
  const base = values.slug ?? slugifySkillName(values.name);
  for (const candidate of [base, suffixedSkillSlug(base), suffixedSkillSlug(base)]) {
    const rows = await db
      .insert(skills)
      .values({ ...values, slug: candidate })
      .onConflictDoNothing({ target: skills.slug })
      .returning();
    if (rows[0]) return rows[0];
  }
  throw new Error("Could not allocate a unique skill slug.");
}
