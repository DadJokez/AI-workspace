import { describe, expect, it } from "vitest";
import type { UiMessage } from "@/app/chat/chat-client-state";
import {
  deriveContributionStudio,
  isSafeBrowserEvidenceUrl,
  resolveContributionStudioTab,
} from "@/lib/contribution-studio";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";

const artifact: WorkspaceArtifactSummary = {
  id: "artifact-1",
  title: "Quarterly brief",
  filename: "quarterly-brief.md",
  kind: "markdown",
  mimeType: "text/markdown",
  sizeBytes: 420,
  source: "assistant-code-block",
  threadId: "thread-1",
  chatMessageId: "assistant-1",
  runId: "run-1",
  artifactGroupId: "brief",
  versionNumber: 1,
  supersedesArtifactId: null,
  versionSummary: null,
  metadata: {},
  createdAt: "2026-08-10T12:00:04.000Z",
  previewUrl: "/preview/1",
  downloadUrl: "/download/1",
};

function assistant(overrides: Partial<UiMessage> = {}): UiMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "Done.",
    createdAt: "2026-08-10T12:00:00.000Z",
    runId: "run-1",
    runStatus: "succeeded",
    persisted: true,
    ...overrides,
  };
}

describe("Contribution Studio model", () => {
  it("derives capability tabs and thread-scoped resources from messages", () => {
    const model = deriveContributionStudio([
      assistant({
        artifacts: [artifact],
        sources: [
          {
            n: 1,
            title: "Primary evidence",
            kind: "web",
            url: "https://example.com/evidence",
            toolCallId: "tool-1",
          },
          {
            n: 2,
            title: "Unsafe evidence",
            kind: "web",
            url: "javascript:alert(1)",
          },
        ],
        activityEvents: [
          {
            id: "tool-1",
            state: "succeeded",
            label: "Checked primary evidence",
            category: "tools",
            at: "2026-08-10T12:00:01.000Z",
          },
        ],
      }),
    ]);

    expect(model.tabs).toEqual(["preview", "files", "browser", "activity"]);
    expect(model.tabs).not.toContain("console");
    expect(model.files.map((file) => file.id)).toEqual(["artifact-1"]);
    expect(model.browserEvidence[0]).toMatchObject({
      title: "Primary evidence",
      url: "https://example.com/evidence",
    });
    expect(model.browserEvidence[1]).toMatchObject({ title: "Unsafe evidence" });
    expect(model.browserEvidence[1]).not.toHaveProperty("url");
    expect(model.workSteps[0]).toMatchObject({
      state: "completed",
      runId: "run-1",
      evidence: [expect.objectContaining({ title: "Primary evidence" })],
    });
    expect(JSON.stringify(model)).not.toContain("providerReasoning");
  });

  it("maps structured lifecycle events without inventing hidden reasoning", () => {
    const states = deriveContributionStudio([
      assistant({
        activityEvents: [
          { id: "planned", state: "pending", label: "Queued research", category: "progress" },
          { id: "waiting", state: "pending", label: "Waiting for approval", category: "tools" },
          { id: "failed", state: "failed", label: "Could not query CRM", category: "tools" },
          { id: "canceled", state: "succeeded", label: "Run canceled", category: "progress" },
        ],
        providerReasoning: [
          { iteration: 1, blockIndex: 0, text: "private reasoning", redacted: false },
        ],
      }),
    ]).workSteps.map((step) => step.state);

    expect(states).toContain("planned");
    expect(states).toContain("failed");
    expect(states).toContain("canceled");
  });

  it("uses direct response state and never exposes Console without capability", () => {
    const active = deriveContributionStudio([
      assistant({ content: "", pending: true, runStatus: "running" }),
    ]);
    expect(active.working).toBe(true);
    expect(active.workSteps).toEqual([
      expect.objectContaining({ state: "active", label: "Preparing response" }),
    ]);
    expect(active.tabs).toEqual(["activity"]);

    const sandboxed = deriveContributionStudio([assistant()], {
      capabilities: { console: true },
    });
    expect(sandboxed.tabs).toContain("console");
  });

  it("resolves requested, contextual, remembered, and fallback tabs", () => {
    const available = ["preview", "files", "activity"] as const;
    expect(
      resolveContributionStudioTab({ available, requested: "files" }),
    ).toBe("files");
    expect(
      resolveContributionStudioTab({ available, artifact, remembered: "files" }),
    ).toBe("preview");
    expect(
      resolveContributionStudioTab({ available, working: true, remembered: "files" }),
    ).toBe("activity");
    expect(resolveContributionStudioTab({ available, remembered: "files" })).toBe(
      "files",
    );
  });

  it("allows only http(s) evidence links", () => {
    expect(isSafeBrowserEvidenceUrl("https://example.com")).toBe(true);
    expect(isSafeBrowserEvidenceUrl("http://localhost:3000/test")).toBe(true);
    expect(isSafeBrowserEvidenceUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeBrowserEvidenceUrl("file:///tmp/private.txt")).toBe(false);
  });
});
