import {
  detectProtectedKeyConflicts,
  type PinnedOrgInstructions,
} from "@ai-workspace/agent";
import {
  type Database,
  type UserMemoryItem,
  auditLog,
  userMemoryItems,
} from "@ai-workspace/db";
import { and, asc, eq, inArray, or, type SQL } from "drizzle-orm";

export const VAULT_MEMORY_MAX_PROMPT_CHARS = 8_000;
export const ORG_INSTRUCTIONS_HEADING = "# Organization Standing Instructions";
const PERSONAL_HEADING = "# Personal Context";

/**
 * Row scope (#438): `user` rows are one person's Vault, read and written by
 * that person; `org` rows are organization standing instructions, written
 * by admins (user_id = the authoring admin) and read by everyone.
 */
export type MemoryScope = "user" | "org";

export const MEMORY_CATEGORY_LABELS: Record<string, string> = {
  working_style: "Working Style",
  communication: "Communication",
  preferences: "Preferences",
  current_priorities: "Current Priorities",
  projects: "Projects",
  systems: "Systems",
  constraints: "Constraints",
  decisions: "Decisions",
  personal_context: "Personal Context",
};

const CATEGORY_ORDER = [
  "current_priorities",
  "projects",
  "working_style",
  "communication",
  "preferences",
  "systems",
  "constraints",
  "decisions",
  "personal_context",
];

export interface SerializedMemoryItem {
  id: string;
  scope: MemoryScope;
  status: UserMemoryItem["status"];
  category: string;
  categoryLabel: string;
  title: string;
  bodyMd: string;
  confidence: number;
  reason: string | null;
  sourceThreadId: string | null;
  sourceMessageIds: string[];
  provenance: "user_stated" | "user_cited" | "unverified";
  suggestedBy: string;
  approvedAt: string | null;
  dismissedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function loadApprovedVaultMarkdown(
  db: Database,
  userId: string,
  maxChars = VAULT_MEMORY_MAX_PROMPT_CHARS,
): Promise<string | null> {
  const rows = await db
    .select()
    .from(userMemoryItems)
    .where(
      and(
        eq(userMemoryItems.userId, userId),
        eq(userMemoryItems.scope, "user"),
        eq(userMemoryItems.status, "approved"),
      ),
    )
    .orderBy(asc(userMemoryItems.category), asc(userMemoryItems.createdAt));

  const markdown = buildVaultMarkdown(rows);
  if (!markdown) return null;
  return capForPrompt(markdown, maxChars);
}

export function buildVaultMarkdown(
  items: readonly UserMemoryItem[],
  heading: string = PERSONAL_HEADING,
): string {
  const approved = items
    .filter((item) => item.status === "approved")
    .sort(compareMemoryItems);
  if (approved.length === 0) return "";

  const lines: string[] = [heading];
  let currentCategory: string | null = null;

  for (const item of approved) {
    if (item.category !== currentCategory) {
      currentCategory = item.category;
      lines.push("", `## ${categoryLabel(item.category)}`);
    }
    lines.push(renderMemoryBullet(item));
  }

  return lines.join("\n").trim();
}

export function serializeMemoryItem(
  item: UserMemoryItem,
): SerializedMemoryItem {
  return {
    id: item.id,
    scope: item.scope === "org" ? "org" : "user",
    status: item.status,
    category: item.category,
    categoryLabel: categoryLabel(item.category),
    title: item.title,
    bodyMd: item.bodyMd,
    confidence: item.confidence,
    reason: item.reason,
    sourceThreadId: item.sourceThreadId,
    sourceMessageIds: Array.isArray(item.sourceMessageIds)
      ? item.sourceMessageIds
      : [],
    provenance: memoryProvenance(item),
    suggestedBy: item.suggestedBy,
    approvedAt: item.approvedAt?.toISOString() ?? null,
    dismissedAt: item.dismissedAt?.toISOString() ?? null,
    archivedAt: item.archivedAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function memoryProvenance(
  item: UserMemoryItem,
): SerializedMemoryItem["provenance"] {
  if (item.suggestedBy === "user" || item.suggestedBy === "onboarding") {
    return "user_stated";
  }
  const metadata =
    item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
      ? (item.metadata as Record<string, unknown>)
      : null;
  const provenance =
    metadata?.provenance &&
    typeof metadata.provenance === "object" &&
    !Array.isArray(metadata.provenance)
      ? (metadata.provenance as Record<string, unknown>)
      : null;
  return item.suggestedBy === "memory-capture:user-cited" &&
    provenance?.sourceRole === "user"
    ? "user_cited"
    : "unverified";
}

export function normalizeMemoryCategory(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "personal_context";
}

export function categoryLabel(category: string): string {
  return (
    MEMORY_CATEGORY_LABELS[category] ??
    category
      .split("_")
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

export async function loadUserMemoryItems(
  db: Database,
  userId: string,
  statuses: UserMemoryItem["status"][] = ["approved", "suggested"],
): Promise<UserMemoryItem[]> {
  if (statuses.length === 0) return [];
  return db
    .select()
    .from(userMemoryItems)
    .where(
      and(
        eq(userMemoryItems.userId, userId),
        eq(userMemoryItems.scope, "user"),
        inArray(userMemoryItems.status, statuses),
      ),
    )
    .orderBy(asc(userMemoryItems.category), asc(userMemoryItems.createdAt));
}

/** Organization rows (#438): no user filter — the org layer is shared. */
export async function loadOrgMemoryItems(
  db: Database,
  statuses: UserMemoryItem["status"][] = ["approved"],
): Promise<UserMemoryItem[]> {
  if (statuses.length === 0) return [];
  return db
    .select()
    .from(userMemoryItems)
    .where(
      and(
        eq(userMemoryItems.scope, "org"),
        inArray(userMemoryItems.status, statuses),
      ),
    )
    .orderBy(asc(userMemoryItems.category), asc(userMemoryItems.createdAt));
}

/**
 * The pinned-layer input plus the approved rows that produced it, so a
 * protected-key conflict can be attributed to the row's author. Only
 * `markdown` and `items` reach the prompt and the receipt.
 */
export interface LoadedOrgInstructions extends PinnedOrgInstructions {
  rows: readonly UserMemoryItem[];
}

/**
 * The single approved organization document for the pinned layer (#438),
 * or `null` when nothing is configured. Same prompt budget as the Vault.
 */
export async function loadApprovedOrgInstructions(
  db: Database,
  maxChars = VAULT_MEMORY_MAX_PROMPT_CHARS,
): Promise<LoadedOrgInstructions | null> {
  const rows = await loadOrgMemoryItems(db, ["approved"]);
  const markdown = buildVaultMarkdown(rows, ORG_INSTRUCTIONS_HEADING);
  if (!markdown) return null;
  return { markdown: capForPrompt(markdown, maxChars), items: rows.length, rows };
}

/**
 * Who may edit/archive which rows (#438): a user touches only their own
 * personal rows; an admin additionally touches every org row. Rendered
 * into the UPDATE's WHERE so a demoted author cannot keep editing org text.
 */
export function memoryWriteCondition(
  actor: { id: string; role: string },
  id: string,
): SQL {
  const own = eq(userMemoryItems.userId, actor.id);
  return actor.role === "admin"
    ? and(eq(userMemoryItems.id, id), or(own, eq(userMemoryItems.scope, "org")))!
    : and(eq(userMemoryItems.id, id), own, eq(userMemoryItems.scope, "user"))!;
}

/**
 * #438 AC: an org document that tries to change protected keys loses to
 * the pinned layer (the prompt says so) AND the attempt is logged, so the
 * conflict is visible on the admin audit surface, not only in the receipt.
 * The denied row is attributed to the admin who wrote the offending row —
 * one row per turn per author — never to the user whose turn happened to
 * load the document; that user is recorded as `input.loadedForUserId`. A
 * conflicting line that cannot be traced to an approved row (only possible
 * when the prompt cap cut a bullet mid-line) is logged under a system actor.
 */
export async function recordOrgInstructionConflict({
  db,
  runId,
  loadedForUserId,
  threadId,
  orgInstructions,
}: {
  db: Database;
  runId: string;
  loadedForUserId: string;
  threadId: string;
  orgInstructions: LoadedOrgInstructions;
}): Promise<void> {
  const now = new Date();
  const base = {
    actionType: "instruction_layers.protected_key_conflict",
    status: "denied" as const,
    provider: "ai-hub",
    toolName: "org-instructions",
    runId,
    chatThreadId: threadId,
    metadata: {
      precedence: "governance > org > skill > personal > thread",
      outcome: "pinned layer wins; conflicting org lines are void",
    },
    startedAt: now,
    completedAt: now,
  };
  const byAuthor = new Map<
    string,
    { orgItemIds: string[]; conflicts: string[] }
  >();
  for (const row of orgInstructions.rows) {
    const rendered = renderMemoryBullet(row);
    if (!orgInstructions.markdown.includes(rendered)) continue;
    const conflicts = detectProtectedKeyConflicts(rendered);
    if (conflicts.length === 0) continue;
    const entry = byAuthor.get(row.userId) ?? { orgItemIds: [], conflicts: [] };
    entry.orgItemIds.push(row.id);
    entry.conflicts.push(...conflicts);
    byAuthor.set(row.userId, entry);
  }
  await db.insert(auditLog).values(
    byAuthor.size > 0
      ? [...byAuthor].map(([authorUserId, { orgItemIds, conflicts }]) => ({
          ...base,
          actorUserId: authorUserId,
          input: {
            layer: "org",
            conflicts: conflicts.slice(0, 5),
            orgItemIds,
            loadedForUserId,
          },
        }))
      : [
          {
            ...base,
            actorUserId: null,
            input: {
              layer: "org",
              conflicts: detectProtectedKeyConflicts(
                orgInstructions.markdown,
              ).slice(0, 5),
              loadedForUserId,
            },
            metadata: { ...base.metadata, actor: "system" },
          },
        ],
  );
}

function capForPrompt(markdown: string, maxChars: number): string {
  if (markdown.length <= maxChars) return markdown;
  return `${markdown.slice(0, Math.max(0, maxChars - 38)).trimEnd()}\n\n[Vault memory truncated for prompt budget]`;
}

function compareMemoryItems(a: UserMemoryItem, b: UserMemoryItem): number {
  const categoryDiff = categoryRank(a.category) - categoryRank(b.category);
  if (categoryDiff !== 0) return categoryDiff;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

function categoryRank(category: string): number {
  const idx = CATEGORY_ORDER.indexOf(category);
  return idx === -1 ? CATEGORY_ORDER.length : idx;
}

function renderMemoryBullet(item: UserMemoryItem): string {
  const body = stripBullet(item.bodyMd).replace(/\s+/g, " ").trim();
  const title = item.title.trim();
  if (!title) return `- ${body}`;
  if (!body || body.toLowerCase() === title.toLowerCase()) {
    return `- ${title}`;
  }
  return `- **${title}:** ${body}`;
}

function stripBullet(value: string): string {
  return value.trim().replace(/^[-*]\s+/, "");
}
