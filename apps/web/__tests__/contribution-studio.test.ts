// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "@/app/chat/chat-client-state";
import { ContributionStudio } from "@/components/ContributionStudio";
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

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("Contribution Studio model", () => {
  it("derives capability tabs and thread-scoped resources from messages", () => {
    const model = deriveContributionStudio(
      [assistant({
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
      })],
      { capabilities: { browser: true } },
    );

    expect(model.tabs).toEqual(["preview", "files", "browser", "activity"]);
    expect(model.tabs).not.toContain("console");
    expect(model.files.map((file) => file.id)).toEqual(["artifact-1"]);
    expect(model.browserEvidence[0]).toMatchObject({
      messageId: "assistant-1",
      sourceNumber: 1,
      title: "Primary evidence",
      url: "https://example.com/evidence",
    });
    expect(model.browserEvidence[1]).toMatchObject({ title: "Unsafe evidence" });
    expect(model.browserEvidence[1]).not.toHaveProperty("url");
    expect(model.browserResources).toEqual([
      expect.objectContaining({
        title: "Primary evidence",
        target: {
          kind: "evidence",
          messageId: "assistant-1",
          sourceNumber: 1,
        },
      }),
      expect.objectContaining({
        title: "quarterly-brief.md",
        target: { kind: "artifact", artifactId: "artifact-1" },
      }),
    ]);
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

  it("does not infer lifecycle state from successful tool labels", () => {
    const steps = deriveContributionStudio([
      assistant({
        id: "assistant-cancel-host",
        activityEvents: [
          {
            id: "host-1",
            state: "succeeded",
            label: "Checked sources details · cancelmyplan.com",
            category: "tools",
          },
        ],
      }),
      assistant({
        id: "assistant-approval-host",
        activityEvents: [
          {
            id: "host-2",
            state: "succeeded",
            label: "Checked sources details · approval.example",
            category: "tools",
          },
        ],
      }),
    ]).workSteps;

    expect(steps.map((step) => step.state)).toEqual([
      "completed",
      "completed",
    ]);

    const active = deriveContributionStudio([
      assistant({
        content: "",
        pending: true,
        runStatus: undefined,
        status: "Calling cancel_subscription…",
        livePhase: "using tools",
      }),
    ]);
    expect(active.workSteps[0]).toMatchObject({ state: "active" });
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

  it("never exposes Browser before its runtime capability is live", () => {
    const message = assistant({
      sources: [
        {
          n: 1,
          title: "Public evidence",
          kind: "web",
          url: "https://example.com",
        },
      ],
    });

    expect(deriveContributionStudio([message]).tabs).not.toContain("browser");
    expect(
      deriveContributionStudio([message], {
        capabilities: { browser: true },
      }).tabs,
    ).toContain("browser");
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

  it("preserves a selected tab while active messages stream", async () => {
    const baseMessage = assistant({
      content: "Working",
      pending: true,
      runStatus: "running",
      artifacts: [artifact],
      activityEvents: [
        {
          id: "tool-streaming",
          state: "pending",
          label: "Checking sources...",
          category: "tools",
        },
      ],
    });
    const props = {
      isAdmin: false,
      onClose: vi.fn(),
      onOpenArtifact: vi.fn(),
      onOpenRunInspector: vi.fn(),
    };
    const view = render(
      createElement(ContributionStudio, {
        ...props,
        messages: [baseMessage],
      }),
    );

    const files = screen.getByRole("button", { name: "Files" });
    fireEvent.click(files);
    expect(files.getAttribute("aria-current")).toBe("page");

    view.rerender(
      createElement(ContributionStudio, {
        ...props,
        messages: [{ ...baseMessage, content: "Working on the brief" }],
      }),
    );

    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Files" })
          .getAttribute("aria-current"),
      ).toBe("page"),
    );
  });
});
