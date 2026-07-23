import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/recommendation-persistence", () => ({
  loadRecommendationsForMessages: async () => new Map(),
}));
import {
  activeRunMessageContent,
  chatRunLane,
  chatRunSourceMessageId,
  latestVisibleChatRunIds,
  reconcileAppDraftVersionSummaries,
  type AppVersionTruthRow,
} from "@/lib/thread-messages";

describe("chatRunLane", () => {
  it("reads only known lanes from stored run metadata", () => {
    expect(chatRunLane({ runtimeRoute: { lane: "tool-local" } })).toBe(
      "tool-local",
    );
    expect(chatRunLane({ runtimeRoute: { lane: "somewhere-else" } })).toBe(
      undefined,
    );
    expect(chatRunLane(null)).toBeUndefined();
  });
});

describe("activeRunMessageContent", () => {
  it("keeps a usage-only running checkpoint visually empty after refresh", () => {
    expect(
      activeRunMessageContent({
        status: "running",
        output: { liveTokens: 8_400 },
      }),
    ).toBe("");
  });

  it("#244 hides interrupted artifact snippets behind a clear retry message", () => {
    const content = activeRunMessageContent({
      status: "canceled",
      output: {
        assistantText: [
          "Here is the update:",
          "",
          '```html filename="theme-picker.html"',
          "<!doctype html>",
          "<html>",
          "<head><title>Theme Picker</title></head>",
          "<body>",
        ].join("\n"),
      },
      hasArtifactContext: true,
    });

    expect(content).toContain("Run canceled before an answer was saved.");
    expect(content).toContain("Artifact update was interrupted");
    expect(content).toContain("Retry the run");
    expect(content).not.toContain("<!doctype html>");
  });

  it("keeps ordinary failed text visible when it is not artifact-like", () => {
    const content = activeRunMessageContent({
      status: "failed",
      error: "Provider unavailable.",
      output: {
        assistantText: "I got partway through the summary before the provider failed.",
      },
    });

    expect(content).toBe(
      "I got partway through the summary before the provider failed.",
    );
  });

  it("keeps failed explanatory snippets visible when no artifact was targeted", () => {
    const content = activeRunMessageContent({
      status: "failed",
      error: "Provider unavailable.",
      output: {
        assistantText: [
          "This HTML snippet demonstrates the issue:",
          "",
          "```html",
          "<button>Save</button>",
          "```",
        ].join("\n"),
      },
    });

    expect(content).toContain("This HTML snippet demonstrates the issue:");
    expect(content).toContain("<button>Save</button>");
    expect(content).not.toContain("Artifact update was interrupted");
  });

  it("uses generic interrupted artifact copy for explicit new files", () => {
    const content = activeRunMessageContent({
      status: "failed",
      output: {
        assistantText: [
          "Here is the file:",
          "",
          '```markdown filename="weekly-brief.md"',
          "# Weekly Brief",
        ].join("\n"),
      },
    });

    expect(content).toContain("Artifact response was interrupted");
    expect(content).not.toContain("Artifact update was interrupted");
    expect(content).not.toContain("# Weekly Brief");
  });
});

describe("chatRunSourceMessageId", () => {
  it("finds the persisted source message used to suppress abandoned branches", () => {
    expect(chatRunSourceMessageId({ userMessageId: "message-1" })).toBe(
      "message-1",
    );
    expect(chatRunSourceMessageId({})).toBeNull();
    expect(chatRunSourceMessageId(null)).toBeNull();
  });

  it("keeps only the latest run for messages on the visible branch", () => {
    const runIds = latestVisibleChatRunIds(
      [
        {
          id: "old-run",
          skillSlug: "chat-turn",
          inputs: { userMessageId: "message-1" },
        },
        {
          id: "abandoned-run",
          skillSlug: "chat-turn",
          inputs: { userMessageId: "message-removed" },
        },
        {
          id: "new-run",
          skillSlug: "chat-turn",
          inputs: { userMessageId: "message-1" },
        },
      ],
      new Set(["message-1"]),
    );

    expect([...runIds]).toEqual(["new-run"]);
  });
});

describe("reconcileAppDraftVersionSummaries (#344)", () => {
  const summary = (overrides = {}) => ({
    id: "version-2",
    appId: "app-1",
    appName: "Revenue Dashboard",
    appSlug: "revenue-dashboard",
    artifactId: "artifact-2",
    versionNumber: 2,
    status: "draft" as const,
    canDeploy: true,
    previewUrl: "/api/apps/app-1/versions/version-2/content",
    liveUrl: "/apps/revenue-dashboard",
    ...overrides,
  });
  const truth = (rows: AppVersionTruthRow[]) =>
    new Map(rows.map((row) => [row.id, row]));

  it("marks a since-deployed draft as deployed and non-deployable", () => {
    expect(
      reconcileAppDraftVersionSummaries(
        [summary()],
        truth([{ id: "version-2", status: "deployed", liveVersionId: "version-2", archived: false }]),
      ),
    ).toEqual([summary({ status: "deployed", canDeploy: false })]);
  });

  it("marks a reverted version non-deployable", () => {
    expect(
      reconcileAppDraftVersionSummaries(
        [summary()],
        truth([{ id: "version-2", status: "reverted", liveVersionId: "version-3", archived: false }]),
      ),
    ).toEqual([summary({ status: "reverted", canDeploy: false })]);
  });

  it("keeps a still-draft, non-live version deployable", () => {
    expect(
      reconcileAppDraftVersionSummaries(
        [summary()],
        truth([{ id: "version-2", status: "draft", liveVersionId: "version-1", archived: false }]),
      ),
    ).toEqual([summary()]);
  });

  it("keeps a pending proposal reviewable after reload", () => {
    expect(
      reconcileAppDraftVersionSummaries(
        [summary({ status: "proposed" })],
        truth([
          {
            id: "version-2",
            status: "proposed",
            liveVersionId: "version-1",
            archived: false,
          },
        ]),
      ),
    ).toEqual([summary({ status: "proposed" })]);
  });

  it("keeps discarded proposal history visible but non-actionable", () => {
    expect(
      reconcileAppDraftVersionSummaries(
        [summary({ status: "proposed" })],
        truth([
          {
            id: "version-2",
            status: "discarded",
            liveVersionId: "version-1",
            archived: false,
          },
        ]),
      ),
    ).toEqual([
      summary({ status: "discarded", canDeploy: false }),
    ]);
  });

  it.each(["iterating", "superseded"] as const)(
    "keeps %s proposal history visible but non-actionable after reload",
    (status) => {
      expect(
        reconcileAppDraftVersionSummaries(
          [summary({ status: "proposed" })],
          truth([
            {
              id: "version-2",
              status,
              liveVersionId: "version-1",
              archived: false,
            },
          ]),
        ),
      ).toEqual([summary({ status, canDeploy: false })]);
    },
  );

  it("never widens canDeploy for a summary minted non-deployable", () => {
    expect(
      reconcileAppDraftVersionSummaries(
        [summary({ canDeploy: false })],
        truth([{ id: "version-2", status: "draft", liveVersionId: "version-1", archived: false }]),
      ),
    ).toEqual([summary({ canDeploy: false })]);
  });

  it("removes a stale deploy affordance when the caller no longer has deploy rights", () => {
    expect(
      reconcileAppDraftVersionSummaries(
        [summary()],
        truth([
          {
            id: "version-2",
            status: "draft",
            liveVersionId: "version-1",
            archived: false,
            canDeploy: false,
          },
        ]),
      ),
    ).toEqual([summary({ canDeploy: false })]);
  });

  it("never offers deploy for drafts on archived apps", () => {
    expect(
      reconcileAppDraftVersionSummaries(
        [summary()],
        truth([
          {
            id: "version-2",
            status: "draft",
            liveVersionId: "version-1",
            archived: true,
          },
        ]),
      ),
    ).toEqual([summary({ canDeploy: false })]);
  });

  it("drops summaries whose version row was hard-deleted", () => {
    expect(
      reconcileAppDraftVersionSummaries([summary()], truth([])),
    ).toEqual([]);
  });
});

describe("loadThreadMessagesWithRunActivity reconciliation wiring (#344)", () => {
  // Fluent thenable mock: every chained method returns the query; awaiting it
  // resolves the next queue slot. Select order in the loader: messages, runs,
  // runEvents, workspaceArtifacts, then the appVersions truth join.
  function fluentDb(queues: unknown[][]) {
    let calls = 0;
    const make = (slot: number) => {
      const q: Record<string, unknown> = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === "then") {
              return (resolve: (value: unknown) => void) =>
                resolve(queues[slot] ?? []);
            }
            return () => q;
          },
        },
      );
      return q;
    };
    return {
      db: { select: () => make(calls++) } as never,
      selectCalls: () => calls,
    };
  }

  const summary = (id: string, versionNumber: number, canDeploy = true) => ({
    id,
    appId: "app-1",
    appName: "Revenue Dashboard",
    appSlug: "revenue-dashboard",
    artifactId: `artifact-${id}`,
    versionNumber,
    status: "draft",
    canDeploy,
    previewUrl: `/api/apps/app-1/versions/${id}/content`,
    liveUrl: "/apps/revenue-dashboard",
  });

  it("rewrites persisted and active-run summaries from version truth", async () => {
    const { loadThreadMessagesWithRunActivity } = await import(
      "@/lib/thread-messages"
    );
    const { db } = fluentDb([
      [
        {
          id: "m1",
          role: "assistant",
          content: "Saved drafts.",
          modelId: null,
          runtime: null,
          toolCalls: null,
          toolResults: null,
          tokensIn: 21_533,
          tokensOut: 10,
          createdAt: new Date(1),
        },
      ],
      [
        {
          id: "r1",
          skillSlug: "chat-turn",
          status: "succeeded",
          modelId: null,
          runtime: null,
          error: null,
          inputs: {},
          outputs: {
            assistantMessageId: "m1",
            sources: [
              {
                n: 1,
                title: "Attribution pull request",
                url: "https://github.com/DadJokez/AI-workspace/pull/542",
                kind: "repo",
                toolCallId: "github-pr",
              },
            ],
            appDraftVersions: [
              summary("vA", 2),
              summary("vB", 3),
              summary("vC", 4),
            ],
          },
          startedAt: null,
          createdAt: new Date(2),
        },
        {
          id: "r2",
          skillSlug: "chat-turn",
          status: "running",
          modelId: null,
          runtime: null,
          error: null,
          inputs: {},
          outputs: {
            appDraftVersions: [summary("vD", 5)],
            usage: { tokensIn: 8_000, tokensOut: 400 },
          },
          startedAt: new Date(3),
          createdAt: new Date(3),
        },
      ],
      [],
      [],
      [
        // vA deployed and live; vB still "draft" but IS the live pointer;
        // vC missing (hard-deleted); vD draft on an archived app.
        { id: "vA", status: "deployed", liveVersionId: "vA", archivedAt: null },
        { id: "vB", status: "draft", liveVersionId: "vB", archivedAt: null },
        { id: "vD", status: "draft", liveVersionId: null, archivedAt: new Date(4) },
      ],
    ]);

    const messages = await loadThreadMessagesWithRunActivity({
      db,
      threadId: "thread-1",
    });

    const persisted = messages.find((message) => message.id === "m1");
    // #330: persisted usage rides through to the cost meter.
    expect(persisted?.tokensIn).toBe(21_533);
    expect(persisted?.tokensOut).toBe(10);
    expect(persisted?.sources).toEqual([
      {
        n: 1,
        title: "Attribution pull request",
        url: "https://github.com/DadJokez/AI-workspace/pull/542",
        kind: "repo",
        toolCallId: "github-pr",
      },
    ]);
    expect(persisted?.appDraftVersions).toEqual([
      expect.objectContaining({ id: "vA", status: "deployed", canDeploy: false }),
      expect.objectContaining({ id: "vB", status: "draft", canDeploy: false }),
    ]);

    const active = messages.find((message) => message.id === "run:r2");
    expect(active?.appDraftVersions).toEqual([
      expect.objectContaining({ id: "vD", status: "draft", canDeploy: false }),
    ]);
    expect(active?.liveTokens).toBe(8_400);
  });

  it("skips the truth query when no summaries rehydrated", async () => {
    const { loadThreadMessagesWithRunActivity } = await import(
      "@/lib/thread-messages"
    );
    const { db, selectCalls } = fluentDb([
      [
        {
          id: "m1",
          role: "assistant",
          content: "Plain answer.",
          modelId: null,
          runtime: null,
          toolCalls: null,
          toolResults: null,
          createdAt: new Date(1),
        },
      ],
      [],
      [],
      [],
    ]);

    await loadThreadMessagesWithRunActivity({ db, threadId: "thread-1" });
    // messages, runs, artifacts — no runEvents (no runs) and no truth join.
    expect(selectCalls()).toBe(3);
  });

  it("drops app-version telemetry after the caller's share is revoked", async () => {
    const { loadThreadMessagesWithRunActivity } = await import(
      "@/lib/thread-messages"
    );
    const { db } = fluentDb([
      [
        {
          id: "m1",
          role: "assistant",
          content: "Saved a draft.",
          modelId: null,
          runtime: null,
          toolCalls: null,
          toolResults: null,
          tokensIn: null,
          tokensOut: null,
          createdAt: new Date(1),
        },
      ],
      [
        {
          id: "r1",
          skillSlug: "chat-turn",
          status: "succeeded",
          modelId: null,
          runtime: null,
          error: null,
          inputs: {},
          outputs: {
            assistantMessageId: "m1",
            appDraftVersions: [summary("vA", 2)],
          },
          startedAt: null,
          createdAt: new Date(2),
        },
      ],
      [],
      [],
      [
        {
          id: "vA",
          status: "draft",
          appId: "app-1",
          ownerUserId: "owner-1",
          liveVersionId: null,
          archivedAt: null,
        },
      ],
      // resolveAppActorRole: no current share for the caller.
      [],
    ]);

    const messages = await loadThreadMessagesWithRunActivity({
      db,
      threadId: "thread-1",
      actor: { id: "former-editor-1", role: "user" },
    });

    expect(
      messages.find((message) => message.id === "m1")?.appDraftVersions,
    ).toEqual([]);
  });
});
