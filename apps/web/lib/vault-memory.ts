import {
  type Database,
  type UserMemoryItem,
  userMemoryItems,
} from "@ai-workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";

export const VAULT_MEMORY_MAX_PROMPT_CHARS = 8_000;

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
  status: UserMemoryItem["status"];
  category: string;
  categoryLabel: string;
  title: string;
  bodyMd: string;
  confidence: number;
  reason: string | null;
  sourceThreadId: string | null;
  sourceMessageIds: string[];
  provenance: "user_stated" | "unverified";
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
      and(eq(userMemoryItems.userId, userId), eq(userMemoryItems.status, "approved")),
    )
    .orderBy(asc(userMemoryItems.category), asc(userMemoryItems.createdAt));

  const markdown = buildVaultMarkdown(rows);
  if (!markdown) return null;
  if (markdown.length <= maxChars) return markdown;
  return `${markdown.slice(0, Math.max(0, maxChars - 38)).trimEnd()}\n\n[Vault memory truncated for prompt budget]`;
}

export function buildVaultMarkdown(items: readonly UserMemoryItem[]): string {
  const approved = items
    .filter((item) => item.status === "approved")
    .sort(compareMemoryItems);
  if (approved.length === 0) return "";

  const lines: string[] = ["# Personal Context"];
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
  return item.suggestedBy === "memory-capture:user-grounded" &&
    provenance?.sourceRole === "user"
    ? "user_stated"
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
        inArray(userMemoryItems.status, statuses),
      ),
    )
    .orderBy(asc(userMemoryItems.category), asc(userMemoryItems.createdAt));
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
