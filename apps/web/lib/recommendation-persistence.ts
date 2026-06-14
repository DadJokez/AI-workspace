import {
  chatMessages,
  type Database,
  recommendations,
  skills,
} from "@ai-workspace/db";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { loadUserMcpProviderStatus } from "@/lib/oauth/mcp-servers";
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
}: {
  db: Database;
  userId: string;
  threadId: string;
  chatMessageId: string;
  runId: string;
  userMessageId: string;
  artifacts: readonly WorkspaceArtifactSummary[];
}): Promise<PersistedRecommendation[]> {
  const [currentRows, recentRows, skillRows, providerStatus] = await Promise.all([
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
    db
      .select({
        id: skills.id,
        name: skills.name,
        description: skills.description,
        mcpProviders: skills.mcpProviders,
        isStarter: skills.isStarter,
      })
      .from(skills)
      .where(
        and(
          isNull(skills.archivedAt),
          or(eq(skills.ownerUserId, userId), eq(skills.isStarter, true)),
        ),
      )
      .orderBy(desc(skills.updatedAt))
      .limit(40),
    loadUserMcpProviderStatus(db, userId),
  ]);

  const currentMessage = currentRows[0]?.content ?? "";
  const candidates = buildRecommendationCandidates({
    currentMessage,
    recentUserMessages: recentRows
      .map((row) => row.content)
      .filter((content) => content !== currentMessage),
    connectedProviders: providerStatus.connectedProviders,
    approvedProviders: providerStatus.allowedProviders,
    skills: skillRows.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      mcpProviders: Array.isArray(skill.mcpProviders)
        ? (skill.mcpProviders as string[])
        : [],
      runnableNow: true,
      sharedWithMe: false,
    })),
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      filename: artifact.filename,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
    })),
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
