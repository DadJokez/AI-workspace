import {
  chatMessages,
  type Database,
  recommendations,
} from "@ai-workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  loadUserCapabilityGraph,
  recommendationInputsFromCapabilityGraph,
} from "@/lib/capability-graph";
import {
  buildRecommendationCandidates,
  type PersistedRecommendation,
  type RecommendationCandidate,
  type RecommendationStatus,
} from "@/lib/recommendations";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";

export async function createRecommendationsForAssistantMessage({
  db,
  userId,
  threadId,
  chatMessageId,
  runId,
  userMessageId,
  artifacts,
  suppressedSkillIds = [],
}: {
  db: Database;
  userId: string;
  threadId: string;
  chatMessageId: string;
  runId: string;
  userMessageId: string;
  artifacts: readonly WorkspaceArtifactSummary[];
  suppressedSkillIds?: readonly string[];
}): Promise<PersistedRecommendation[]> {
  const [currentRows, recentRows, capabilityGraph, priorRecommendationRows] =
    await Promise.all([
    db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.id, userMessageId))
      .limit(1),
    db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.threadId, threadId),
          eq(chatMessages.role, "user"),
        ),
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(8),
    loadUserCapabilityGraph(db, { id: userId, role: "user" }),
    db
      .select({ metadata: recommendations.metadata })
      .from(recommendations)
      .where(
        and(
          eq(recommendations.userId, userId),
          eq(recommendations.threadId, threadId),
        ),
      )
      .orderBy(desc(recommendations.createdAt))
      .limit(100),
  ]);

  const currentMessage = currentRows[0]?.content ?? "";
  const capabilityInputs = recommendationInputsFromCapabilityGraph(capabilityGraph);
  const candidates = buildRecommendationCandidates({
    currentMessage,
    currentThreadId: threadId,
    recentUserMessages: recentRows
      .map((row) => row.content)
      .filter((content) => content !== currentMessage),
    connectedProviders: capabilityInputs.connectedProviders,
    approvedProviders: capabilityInputs.approvedProviders,
    skills: capabilityInputs.skills,
    apps: capabilityInputs.apps,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      filename: artifact.filename,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
    })),
    suppressedSkillIds,
    suppressedCandidateIds: priorRecommendationRows
      .map((row) => candidateIdFromMetadata(row.metadata))
      .filter((id): id is string => Boolean(id)),
  }).slice(0, 3);

  if (candidates.length === 0) return [];

  const rows = await db
    .insert(recommendations)
    .values(
      candidates.map((candidate) => ({
        userId,
        threadId,
        chatMessageId,
        runId,
        type: candidate.type,
        title: candidate.title,
        reason: candidate.reason,
        status: "suggested",
        action: candidate.action,
        metadata: {
          ...candidate.metadata,
          candidateId: candidate.id,
          requiresApproval: candidate.requiresApproval,
        },
      })),
    )
    .returning();

  return rows.map(serializeRecommendation);
}

export async function loadRecentRecommendationsForThread({
  db,
  userId,
  threadId,
  limit = 5,
}: {
  db: Database;
  userId: string;
  threadId: string;
  limit?: number;
}): Promise<PersistedRecommendation[]> {
  const resolvedLimit = Math.max(1, Math.min(limit, 10));
  const rows = await db
    .select()
    .from(recommendations)
    .where(
      and(
        eq(recommendations.userId, userId),
        eq(recommendations.threadId, threadId),
        eq(recommendations.status, "suggested"),
      ),
    )
    .orderBy(desc(recommendations.createdAt))
    .limit(resolvedLimit * 4);

  const seen = new Set<string>();
  const out: PersistedRecommendation[] = [];
  for (const row of rows) {
    const recommendation = serializeRecommendation(row);
    if (seen.has(recommendation.id)) continue;
    seen.add(recommendation.id);
    out.push(recommendation);
    if (out.length >= resolvedLimit) break;
  }
  return out;
}

export async function loadRecommendationsForMessages({
  db,
  messageIds,
}: {
  db: Database;
  messageIds: readonly string[];
}): Promise<Map<string, PersistedRecommendation[]>> {
  if (messageIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(recommendations)
    .where(inArray(recommendations.chatMessageId, [...messageIds]))
    .orderBy(desc(recommendations.createdAt));

  const byMessageId = new Map<string, PersistedRecommendation[]>();
  for (const row of rows) {
    if (!row.chatMessageId) continue;
    const existing = byMessageId.get(row.chatMessageId) ?? [];
    existing.push(serializeRecommendation(row));
    byMessageId.set(row.chatMessageId, existing);
  }
  return byMessageId;
}

export async function updateRecommendationStatus({
  db,
  userId,
  recommendationId,
  status,
}: {
  db: Database;
  userId: string;
  recommendationId: string;
  status: RecommendationStatus;
}): Promise<PersistedRecommendation | null> {
  const rows = await db
    .update(recommendations)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(recommendations.id, recommendationId),
        eq(recommendations.userId, userId),
      ),
    )
    .returning();
  return rows[0] ? serializeRecommendation(rows[0]) : null;
}

function serializeRecommendation(
  row: typeof recommendations.$inferSelect,
): PersistedRecommendation {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  return {
    dbId: row.id,
    id:
      typeof metadata.candidateId === "string"
        ? metadata.candidateId
        : row.id,
    type: row.type as RecommendationCandidate["type"],
    title: row.title,
    reason: row.reason,
    requiresApproval: metadata.requiresApproval !== false,
    action: row.action as RecommendationCandidate["action"],
    metadata,
    status: normalizeStatus(row.status),
    threadId: row.threadId,
    chatMessageId: row.chatMessageId,
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeStatus(value: string): RecommendationStatus {
  return value === "accepted" || value === "dismissed" ? value : "suggested";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function candidateIdFromMetadata(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.candidateId === "string" ? value.candidateId : undefined;
}
