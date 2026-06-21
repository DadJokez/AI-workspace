import { describe, expect, it } from "vitest";
import {
  mergeLoadedMessages,
  nextPreviewArtifactAfterPersisted,
} from "@/app/chat/ChatClient";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";

function artifact(
  partial: Partial<WorkspaceArtifactSummary> & { id: string; versionNumber: number },
): WorkspaceArtifactSummary {
  return {
    title: "Demo Artifact",
    filename: "demo-artifact.html",
    kind: "html",
    mimeType: "text/html",
    sizeBytes: 1200,
    source: "assistant-code-block",
    threadId: "thread-demo",
    chatMessageId: "assistant-demo",
    runId: "run-demo",
    artifactGroupId: "group-demo",
    supersedesArtifactId: null,
    versionSummary: null,
    metadata: {},
    createdAt: "2026-06-19T00:00:00.000Z",
    previewUrl: `/workspace/artifacts/${partial.id}`,
    downloadUrl: `/api/workspace/artifacts/${partial.id}/download`,
    ...partial,
  };
}

describe("chat resume helpers", () => {
  it("keeps in-progress messages when a historical thread finishes loading", () => {
    const loaded = [
      { id: "m1", role: "user" as const, content: "old question" },
      { id: "m2", role: "assistant" as const, content: "old answer" },
    ];
    const current = [
      ...loaded,
      { id: "local-user", role: "user" as const, content: "new follow-up" },
      {
        id: "local-assistant",
        role: "assistant" as const,
        content: "",
        pending: true,
        status: "Thinking...",
      },
    ];

    expect(mergeLoadedMessages(loaded, current)).toEqual(current);
  });

  it("does not duplicate optimistic messages that have already persisted", () => {
    const loaded = [
      { id: "db-user", role: "user" as const, content: "new follow-up" },
      { id: "db-assistant", role: "assistant" as const, content: "answer" },
    ];
    const current = [
      { id: "local-user", role: "user" as const, content: "new follow-up" },
      { id: "local-assistant", role: "assistant" as const, content: "answer" },
    ];

    expect(mergeLoadedMessages(loaded, current)).toEqual(loaded);
  });

  it("moves an open artifact preview to the newly persisted version", () => {
    const v1 = artifact({ id: "artifact-demo-v1", versionNumber: 1 });
    const v2 = artifact({
      id: "artifact-demo-v2",
      versionNumber: 2,
      supersedesArtifactId: v1.id,
    });

    expect(nextPreviewArtifactAfterPersisted(v1, [v2])).toBe(v2);
  });
});
