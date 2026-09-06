import {
  detectProtectedKeyConflicts,
  type PinnedOrgInstructions,
} from "@ai-workspace/agent";
import {
  type Database,
  type OrgInstruction,
  auditLog,
  orgInstructions,
} from "@ai-workspace/db";
import { asc, eq } from "drizzle-orm";
import { VAULT_MEMORY_MAX_PROMPT_CHARS } from "@/lib/vault-memory";

/**
 * Organization standing instructions (#438, layer 3). Storage is the
 * dedicated `org_instructions` table — never the per-user Vault table, whose
 * rows cascade-delete with their user (Rob's decision, 2026-09-06): the org
 * layer must outlive the admin who wrote it. Every user reads the approved
 * rows; only admins write them (apps/web/app/api/org-instructions/*).
 */

export const ORG_INSTRUCTIONS_HEADING = "# Organization Standing Instructions";
export const ORG_INSTRUCTION_CONTENT_MAX = 4_000;

/** Request content, trimmed, non-empty and within budget — or null. */
export function parseOrgInstructionContent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const content = value.trim();
  if (!content || content.length > ORG_INSTRUCTION_CONTENT_MAX) return null;
  return content;
}

export interface SerializedOrgInstruction {
  id: string;
  status: OrgInstruction["status"];
  content: string;
  authoredBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeOrgInstruction(
  row: OrgInstruction,
): SerializedOrgInstruction {
  return {
    id: row.id,
    status: row.status,
    content: row.content,
    authoredBy: row.authoredBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Approved rows, oldest first — the order the document renders in. */
export async function loadApprovedOrgInstructionRows(
  db: Database,
): Promise<OrgInstruction[]> {
  return db
    .select()
    .from(orgInstructions)
    .where(eq(orgInstructions.status, "approved"))
    .orderBy(asc(orgInstructions.createdAt));
}

/** The approved rows as one document; empty when nothing is configured. */
export function buildOrgInstructionsMarkdown(
  rows: readonly OrgInstruction[],
): string {
  const blocks = rows
    .filter((row) => row.status === "approved")
    .map((row) => row.content.trim())
    .filter(Boolean);
  if (blocks.length === 0) return "";
  return [ORG_INSTRUCTIONS_HEADING, ...blocks].join("\n\n");
}

/**
 * The pinned-layer input plus the approved rows that produced it, so a
 * protected-key conflict can be attributed to the row's author. Only
 * `markdown` and `items` reach the prompt and the receipt.
 */
export interface LoadedOrgInstructions extends PinnedOrgInstructions {
  rows: readonly OrgInstruction[];
}

/**
 * The single approved organization document for the pinned layer (#438),
 * or `null` when nothing is configured. Same prompt budget as the Vault.
 */
export async function loadApprovedOrgInstructions(
  db: Database,
  maxChars = VAULT_MEMORY_MAX_PROMPT_CHARS,
): Promise<LoadedOrgInstructions | null> {
  const rows = await loadApprovedOrgInstructionRows(db);
  const markdown = buildOrgInstructionsMarkdown(rows);
  if (!markdown) return null;
  return { markdown: capForPrompt(markdown, maxChars), items: rows.length, rows };
}

/**
 * #438 AC: an org document that tries to change protected keys loses to
 * the pinned layer (the prompt says so) AND the attempt is logged, so the
 * conflict is visible on the admin audit surface, not only in the receipt.
 * The denied row is attributed to the admin who wrote the offending row —
 * one row per turn per author — never to the user whose turn happened to
 * load the document; that user is recorded as `input.loadedForUserId`.
 * The system actor (`metadata.actor = "system"`, null actor) takes the row
 * when the author is gone (`authored_by` was SET NULL on deletion) or when
 * a conflicting line cannot be traced to a row (only possible when the
 * prompt cap cut the document mid-way).
 */
export async function recordOrgInstructionConflict({
  db,
  runId,
  loadedForUserId,
  threadId,
  orgInstructions: loaded,
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
    string | null,
    { orgInstructionIds: string[]; conflicts: string[] }
  >();
  for (const row of loaded.rows) {
    const content = row.content.trim();
    if (!loaded.markdown.includes(content)) continue;
    const conflicts = detectProtectedKeyConflicts(content);
    if (conflicts.length === 0) continue;
    const entry = byAuthor.get(row.authoredBy) ?? {
      orgInstructionIds: [],
      conflicts: [],
    };
    entry.orgInstructionIds.push(row.id);
    entry.conflicts.push(...conflicts);
    byAuthor.set(row.authoredBy, entry);
  }
  if (byAuthor.size === 0) {
    byAuthor.set(null, {
      orgInstructionIds: [],
      conflicts: detectProtectedKeyConflicts(loaded.markdown),
    });
  }
  await db.insert(auditLog).values(
    [...byAuthor].map(([authorUserId, { orgInstructionIds, conflicts }]) => ({
      ...base,
      actorUserId: authorUserId,
      input: {
        layer: "org",
        conflicts: conflicts.slice(0, 5),
        orgInstructionIds,
        loadedForUserId,
      },
      metadata: authorUserId
        ? base.metadata
        : { ...base.metadata, actor: "system" },
    })),
  );
}

const TRUNCATION_NOTICE =
  "\n\n[Organization instructions truncated for prompt budget]";

function capForPrompt(markdown: string, maxChars: number): string {
  if (markdown.length <= maxChars) return markdown;
  return `${markdown
    .slice(0, Math.max(0, maxChars - TRUNCATION_NOTICE.length))
    .trimEnd()}${TRUNCATION_NOTICE}`;
}
