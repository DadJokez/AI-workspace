import { mcpToolName } from "@ai-workspace/agent";
import type { McpServerSpec } from "@ai-workspace/agent-runtime";
import {
  type Database,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { and, eq, inArray } from "drizzle-orm";

import type { ChatContextUploadedFile } from "@/lib/chat-context-pack";
import {
  buildConversationResourceTurnContext,
  RESOURCE_MCP_CONTEXT_HEADER,
  RESOURCE_MCP_RELAY_HEADER,
  resourceMcpRelayToken,
  signConversationResourceTurnContext,
} from "@/lib/conversation-resource-authorization";
import {
  CONVERSATION_RESOURCE_MCP_PATH,
  type ConversationResourceResolution,
} from "@/lib/conversation-resources";
import { PUBLIC_BASE_URL } from "@/lib/oauth/github";
import { threadBranchHasPinnedResource } from "@/lib/thread-branches";

export const CONVERSATION_RESOURCE_PROVIDER = "resources";
export const CONVERSATION_RESOURCE_QUERY_TOOL = mcpToolName(
  CONVERSATION_RESOURCE_PROVIDER,
  "query",
);

export function buildConversationResourceMcpServer({
  userId,
  threadId,
  runId,
  resolution,
}: {
  userId: string;
  threadId: string;
  runId: string;
  resolution: ConversationResourceResolution;
}): McpServerSpec | null {
  if (resolution.status !== "selected" || resolution.selected.length === 0) {
    return null;
  }
  const context = buildConversationResourceTurnContext({
    userId,
    threadId,
    runId,
    resolution,
  });
  return {
    type: "http",
    url: new URL(
      CONVERSATION_RESOURCE_MCP_PATH,
      PUBLIC_BASE_URL,
    ).toString(),
    headers: {
      [RESOURCE_MCP_RELAY_HEADER]: resourceMcpRelayToken(),
      [RESOURCE_MCP_CONTEXT_HEADER]:
        signConversationResourceTurnContext(context),
    },
    allowedTools: ["query"],
  };
}

export async function loadSelectedResourceImages({
  db,
  userId,
  threadId,
  resolution,
}: {
  db: Database;
  userId: string;
  threadId: string;
  resolution: ConversationResourceResolution;
}): Promise<ChatContextUploadedFile[]> {
  const selectedImages = resolution.selected.filter(
    (resource) => resource.kind === "image",
  );
  if (selectedImages.length === 0) return [];
  const ids = selectedImages.map((resource) => resource.resourceId);
  const rows = await db
    .select({
      id: workspaceArtifacts.id,
      threadId: workspaceArtifacts.threadId,
      filename: workspaceArtifacts.filename,
      mimeType: workspaceArtifacts.mimeType,
      content: workspaceArtifacts.content,
      sizeBytes: workspaceArtifacts.sizeBytes,
      metadata: workspaceArtifacts.metadata,
    })
    .from(workspaceArtifacts)
    .where(
      and(
        inArray(workspaceArtifacts.id, ids),
        eq(workspaceArtifacts.userId, userId),
        eq(workspaceArtifacts.source, "user-upload"),
      ),
    );
  const authorizedRows = [];
  for (const row of rows) {
    if (
      row.threadId === threadId ||
      (await threadBranchHasPinnedResource({
        db,
        threadId,
        artifactId: row.id,
      }))
    ) {
      authorizedRows.push(row);
    }
  }
  const byId = new Map(authorizedRows.map((row) => [row.id, row]));
  return selectedImages.flatMap((selected) => {
    const row = byId.get(selected.resourceId);
    const metadata = asRecord(row?.metadata);
    if (
      !row ||
      metadata?.storageEncoding !== "base64" ||
      (row.mimeType !== "image/png" &&
        row.mimeType !== "image/jpeg" &&
        row.mimeType !== "image/webp")
    ) {
      return [];
    }
    return [
      {
        resourceId: row.id,
        name: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        extractionStatus: "native_image",
        runtimeContent: {
          type: "image" as const,
          mimeType: row.mimeType,
          dataBase64: row.content,
        },
      },
    ];
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
