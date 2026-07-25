import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  assistantMessage,
  defaultArtifactSummary,
  fulfillSse,
  installMockComparativeApi,
  json,
  userMessage,
} from "./helpers/mock-comparative";
import { gotoE2EChat, openPrimarySidebar } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked chat workflow tests run only against the local e2e harness",
);

function threadSummary(id: string, title: string) {
  return {
    id,
    title,
    defaultModelId: "sonnet-4-6",
    summary: null,
    summaryUpdatedAt: null,
    previewSummary: null,
    previewSummaryUpdatedAt: null,
    titleSource: "generated",
    createdAt: "2026-06-14T20:00:00.000Z",
    updatedAt: "2026-06-14T20:00:00.000Z",
  };
}

test.describe("chat workflow regressions", () => {
  test("durably cancels the active run before releasing the composer", async ({
    page,
  }) => {
    await installMockComparativeApi(page);
    await page.addInitScript(() => {
      type CancelHarness = {
        chatCount: number;
        events: string[];
        emitLateCompletion: () => boolean;
      };
      const browser = window as typeof window & {
        __cancelHarness?: CancelHarness;
      };
      const originalFetch = window.fetch.bind(window);
      const harness: CancelHarness = {
        chatCount: 0,
        events: [],
        emitLateCompletion: () => false,
      };
      browser.__cancelHarness = harness;

      window.fetch = async (input, init) => {
        const requestUrl =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : input.toString();
        const path = new URL(requestUrl, window.location.origin).pathname;
        const method = (
          init?.method ??
          (input instanceof Request ? input.method : "GET")
        ).toUpperCase();

        if (path === "/api/chat" && method === "POST") {
          harness.chatCount += 1;
          const encoder = new TextEncoder();
          const event = (value: unknown) =>
            encoder.encode(`data: ${JSON.stringify(value)}\n\n`);

          if (harness.chatCount > 1) {
            return new Response(
              [
                {
                  type: "meta",
                  threadId: "thread-durable-cancel",
                  runId: "run-recovery",
                  userMessageId: "user-recovery",
                  modelId: "sonnet-4-6",
                  runtimeRoute: {
                    useWorker: false,
                    lane: "fast-local",
                  },
                },
                {
                  type: "text-delta",
                  delta: "RECOVERY_RESPONSE_AFTER_CANCEL",
                },
                {
                  type: "persisted",
                  assistantMessageId: "assistant-recovery",
                  artifacts: [],
                  recommendations: [],
                },
                { type: "done", stopReason: "completed" },
              ]
                .map(
                  (value) => `data: ${JSON.stringify(value)}\n\n`,
                )
                .join(""),
              {
                headers: {
                  "content-type": "text/event-stream; charset=utf-8",
                },
              },
            );
          }

          const signal =
            init?.signal ?? (input instanceof Request ? input.signal : null);
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  event({
                    type: "meta",
                    threadId: "thread-durable-cancel",
                    runId: "run-durable-cancel",
                    userMessageId: "user-durable-cancel",
                    modelId: "sonnet-4-6",
                    runtimeRoute: {
                      useWorker: false,
                      lane: "durable-local",
                    },
                  }),
                );
                controller.enqueue(
                  event({
                    type: "text-delta",
                    delta: "CANCEL_BARRIER_REACHED",
                  }),
                );
                harness.emitLateCompletion = () => {
                  try {
                    controller.enqueue(
                      event({
                        type: "text-delta",
                        delta: "LATE_COMPLETION_MUST_NOT_RENDER",
                      }),
                    );
                    controller.enqueue(
                      event({
                        type: "persisted",
                        assistantMessageId: "assistant-too-late",
                        artifacts: [],
                        recommendations: [],
                      }),
                    );
                    controller.close();
                    harness.events.push("late-enqueued");
                    return true;
                  } catch {
                    harness.events.push("late-blocked");
                    return false;
                  }
                };
                signal?.addEventListener(
                  "abort",
                  () => {
                    harness.events.push("abort");
                    controller.error(
                      new DOMException("The operation was aborted.", "AbortError"),
                    );
                  },
                  { once: true },
                );
              },
            }),
            {
              headers: {
                "content-type": "text/event-stream; charset=utf-8",
              },
            },
          );
        }

        if (
          path === "/api/runs/run-durable-cancel/cancel" &&
          method === "POST"
        ) {
          harness.events.push("cancel");
          return new Response(
            JSON.stringify({
              run: { id: "run-durable-cancel", status: "canceled" },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        return originalFetch(input, init);
      };
    });

    await gotoE2EChat(page);
    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Generate a long report that I will stop.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("CANCEL_BARRIER_REACHED")).toBeVisible();

    await page.getByRole("button", { name: "Stop generating" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __cancelHarness?: { events: string[] };
              }
            ).__cancelHarness?.events ?? [],
        ),
      )
      .toEqual(["cancel", "abort"]);
    await expect(page.getByPlaceholder(/ask anything/i)).toBeEnabled();

    const lateCompletionAccepted = await page.evaluate(
      () =>
        (
          window as typeof window & {
            __cancelHarness?: { emitLateCompletion: () => boolean };
          }
        ).__cancelHarness?.emitLateCompletion() ?? false,
    );
    expect(lateCompletionAccepted).toBe(false);
    await expect(page.getByText("LATE_COMPLETION_MUST_NOT_RENDER")).toHaveCount(
      0,
    );

    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Confirm that the recovery turn is independent.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText("RECOVERY_RESPONSE_AFTER_CANCEL"),
    ).toBeVisible();
  });

  test("keeps the delivered answer when cancel reports result_committed", async ({
    page,
  }) => {
    await installMockComparativeApi(page);
    await page.addInitScript(() => {
      type CommittedHarness = { events: string[] };
      const browser = window as typeof window & {
        __committedHarness?: CommittedHarness;
      };
      const originalFetch = window.fetch.bind(window);
      const harness: CommittedHarness = { events: [] };
      let finishStream = () => {};
      browser.__committedHarness = harness;

      window.fetch = async (input, init) => {
        const requestUrl =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : input.toString();
        const path = new URL(requestUrl, window.location.origin).pathname;
        const method = (
          init?.method ??
          (input instanceof Request ? input.method : "GET")
        ).toUpperCase();

        if (path === "/api/chat" && method === "POST") {
          const encoder = new TextEncoder();
          const event = (value: unknown) =>
            encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
          const signal =
            init?.signal ?? (input instanceof Request ? input.signal : null);
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  event({
                    type: "meta",
                    threadId: "thread-committed-cancel",
                    runId: "run-committed-cancel",
                    userMessageId: "user-committed-cancel",
                    modelId: "sonnet-4-6",
                    runtimeRoute: {
                      useWorker: false,
                      lane: "durable-local",
                    },
                  }),
                );
                controller.enqueue(
                  event({
                    type: "text-delta",
                    delta: "COMMITTED_ANSWER_BODY",
                  }),
                );
                finishStream = () => {
                  controller.enqueue(
                    event({
                      type: "persisted",
                      assistantMessageId: "assistant-committed",
                      artifacts: [],
                      recommendations: [],
                    }),
                  );
                  controller.enqueue(
                    event({ type: "done", stopReason: "completed" }),
                  );
                  controller.close();
                };
                signal?.addEventListener(
                  "abort",
                  () => {
                    harness.events.push("abort");
                    controller.error(
                      new DOMException(
                        "The operation was aborted.",
                        "AbortError",
                      ),
                    );
                  },
                  { once: true },
                );
              },
            }),
            {
              headers: {
                "content-type": "text/event-stream; charset=utf-8",
              },
            },
          );
        }

        if (
          path === "/api/runs/run-committed-cancel/cancel" &&
          method === "POST"
        ) {
          // #655: the durable answer already committed server-side; the run
          // will finish as succeeded, so the cancel reports result_committed
          // and the worker delivers the rest of the stream.
          harness.events.push("cancel");
          finishStream();
          return new Response(
            JSON.stringify({
              run: { id: "run-committed-cancel", status: "running" },
              outcome: "result_committed",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        return originalFetch(input, init);
      };
    });

    await gotoE2EChat(page);
    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Stop right after the answer commits.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("COMMITTED_ANSWER_BODY")).toBeVisible();

    await page.getByRole("button", { name: "Stop generating" }).click();

    // The Stop flow must not abort the stream or claim a cancellation: the
    // answer stands and the turn completes normally.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __committedHarness?: { events: string[] };
              }
            ).__committedHarness?.events ?? [],
        ),
      )
      .toEqual(["cancel"]);
    await expect(page.getByPlaceholder(/ask anything/i)).toBeEnabled();
    await expect(page.getByText("COMMITTED_ANSWER_BODY")).toBeVisible();
    await expect(
      page.getByText("Comparative could not confirm that the run stopped."),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              __committedHarness?: { events: string[] };
            }
          ).__committedHarness?.events ?? [],
      ),
    ).toEqual(["cancel"]);
  });

  test("switching chats detaches a worker stream without canceling its run", async ({
    page,
  }, testInfo) => {
    const activeThreadId = "thread-worker-active";
    const otherThreadId = "thread-worker-other";
    const runId = "run-worker-active";
    const threadMessages: Record<string, unknown[]> = {
      [otherThreadId]: [
        userMessage({ id: "user-other", content: "Other chat question" }),
        assistantMessage({
          id: "assistant-other",
          content: "Other chat answer.",
        }),
      ],
    };
    await installMockComparativeApi(page, {
      threads: [
        threadSummary(activeThreadId, "Background worker chat"),
        threadSummary(otherThreadId, "Other chat"),
      ],
      threadMessages,
    });
    await page.addInitScript(
      ({ activeThreadId, runId }) => {
        type DetachHarness = { events: string[] };
        const browser = window as typeof window & {
          __detachHarness?: DetachHarness;
        };
        const originalFetch = window.fetch.bind(window);
        const harness: DetachHarness = { events: [] };
        browser.__detachHarness = harness;

        window.fetch = async (input, init) => {
          const requestUrl =
            typeof input === "string"
              ? input
              : input instanceof Request
                ? input.url
                : input.toString();
          const path = new URL(requestUrl, window.location.origin).pathname;
          const method = (
            init?.method ??
            (input instanceof Request ? input.method : "GET")
          ).toUpperCase();

          if (path === "/api/chat" && method === "POST") {
            const encoder = new TextEncoder();
            const event = (value: unknown) =>
              encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
            const signal =
              init?.signal ?? (input instanceof Request ? input.signal : null);
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    event({
                      type: "meta",
                      threadId: activeThreadId,
                      runId,
                      userMessageId: "user-worker-active",
                      modelId: "sonnet-4-6",
                      runtimeRoute: {
                        useWorker: true,
                        lane: "durable-local",
                      },
                    }),
                  );
                  controller.enqueue(
                    event({
                      type: "queued",
                      runId,
                      status: "Working in background",
                    }),
                  );
                  harness.events.push("stream-open");
                  signal?.addEventListener(
                    "abort",
                    () => {
                      harness.events.push("detached");
                      controller.error(
                        new DOMException(
                          "The operation was aborted.",
                          "AbortError",
                        ),
                      );
                    },
                    { once: true },
                  );
                },
              }),
              {
                headers: {
                  "content-type": "text/event-stream; charset=utf-8",
                },
              },
            );
          }

          if (
            path === `/api/runs/${runId}/cancel` &&
            method === "POST"
          ) {
            harness.events.push("cancel");
            return new Response(
              JSON.stringify({ run: { id: runId, status: "canceled" } }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            );
          }

          return originalFetch(input, init);
        };
      },
      { activeThreadId, runId },
    );

    await gotoE2EChat(page);
    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Finish this report in the background.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByRole("button", { name: "Stop generating" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __detachHarness?: { events: string[] };
              }
            ).__detachHarness?.events ?? [],
        ),
      )
      .toEqual(["stream-open"]);

    let sidebar = await openPrimarySidebar(
      page,
      testInfo.project.name.includes("mobile"),
    );
    await sidebar.getByRole("button", { name: "Other chat" }).click();
    await expect(page.getByText("Other chat answer.")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __detachHarness?: { events: string[] };
              }
            ).__detachHarness?.events ?? [],
        ),
      )
      .toEqual(["stream-open", "detached"]);

    threadMessages[activeThreadId] = [
      userMessage({
        id: "user-worker-active",
        content: "Finish this report in the background.",
      }),
      assistantMessage({
        id: "assistant-worker-active",
        content: "Background worker result survived the chat switch.",
        runId,
        runStatus: "succeeded",
      }),
    ];

    sidebar = await openPrimarySidebar(
      page,
      testInfo.project.name.includes("mobile"),
    );
    await sidebar
      .getByRole("button", { name: "Background worker chat" })
      .click();
    await expect(
      page.getByText("Background worker result survived the chat switch."),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              __detachHarness?: { events: string[] };
            }
          ).__detachHarness?.events.includes("cancel") ?? false,
      ),
    ).toBe(false);
  });

  test("downloads a reloaded thread through the protected export endpoint", async ({
    page,
    isMobile,
  }) => {
    const threadId = "thread-reloaded-export";
    const title = "Reloaded transcript";
    const firstMarker = "TX1_RELOADED_EXPORT";
    const secondMarker = "TX2_RELOADED_EXPORT";
    const transcript = [
      `# ${title}`,
      "",
      `- Thread ID: ${threadId}`,
      "",
      "## 1. User",
      "",
      firstMarker,
      "",
      "## 2. Assistant",
      "",
      "Recorded review owner Priya.",
      "",
      "## 3. User",
      "",
      secondMarker,
      "",
      "## 4. Assistant",
      "",
      "Recorded review date 15 August 2026.",
      "",
    ].join("\n");
    await installMockComparativeApi(page, {
      threads: [threadSummary(threadId, title)],
      threadMessages: {
        [threadId]: [
          userMessage({ id: "user-export-1", content: firstMarker }),
          assistantMessage({
            id: "assistant-export-1",
            content: "Recorded review owner Priya.",
          }),
          userMessage({ id: "user-export-2", content: secondMarker }),
          assistantMessage({
            id: "assistant-export-2",
            content: "Recorded review date 15 August 2026.",
          }),
        ],
      },
      threadExports: {
        [threadId]: {
          title,
          markdown: transcript,
        },
      },
    });

    await gotoE2EChat(page);
    const sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar.getByRole("button", { name: title }).click();
    await expect(page.getByText(firstMarker)).toBeVisible();
    await expect(page.getByText(secondMarker)).toBeVisible();

    // #664: the URL identifies the open thread, so reload restores it.
    await page.reload();
    await expect(page.getByText(secondMarker)).toBeVisible();

    const exportRequest = page.waitForRequest(
      `**/api/threads/${threadId}/export`,
    );
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download chat transcript" }).click(),
      exportRequest,
    ]);
    expect(download.suggestedFilename()).toMatch(
      /^\d{4}-\d{2}-\d{2}-reloaded-transcript\.md$/,
    );
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const downloaded = await readFile(downloadPath!, "utf8");
    expect(downloaded).toContain(firstMarker);
    expect(downloaded).toContain(secondMarker);
    expect(downloaded).not.toContain("UNRELATED_THREAD_MARKER");
  });

  test("downloads the active chat as markdown", async ({ page }) => {
    await installMockComparativeApi(page, {
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          {
            type: "meta",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta:
              "Exportable answer with enough detail for a transcript and artifact.",
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-export",
            artifacts: [defaultArtifactSummary],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await gotoE2EChat(page);
    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Please make this exportable.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(
        "Exportable answer with enough detail for a transcript and artifact.",
      ),
    ).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download chat transcript" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(
      /^\d{4}-\d{2}-\d{2}-please-make-this-exportable\.md$/,
    );

    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const downloaded = await readFile(downloadPath!, "utf8");
    expect(downloaded).toContain("# Please make this exportable.");
    expect(downloaded).toContain("Please make this exportable.");
    expect(downloaded).toContain(
      "Exportable answer with enough detail for a transcript and artifact.",
    );
    expect(downloaded).not.toContain("- Thread ID:");
    expect(downloaded).toContain("### Artifacts");
    expect(downloaded).toContain("demo-artifact.html (html, 1.3 KB)");
  });

  test("reviews and accepts an unattended artifact proposal in the current chat", async ({
    page,
  }) => {
    const proposal = {
      ...defaultArtifactSummary,
      id: "artifact-proposal-report",
      title: "Weekly report",
      filename: "weekly-report.md",
      kind: "document",
      mimeType: "text/markdown",
      artifactGroupId: "weekly-report",
      versionNumber: 2,
      supersedesArtifactId: "artifact-report-v1",
      versionSummary: "Updated the launch risks and next steps.",
      metadata: {
        lineDelta: { added: 3, removed: 1, approximate: false },
        outputProposal: {
          status: "proposed",
          runId: "run-proposal-report",
          triggerType: "scheduled",
          createdAt: "2026-07-23T12:00:00.000Z",
        },
      },
    };
    const accepted = {
      ...proposal,
      metadata: {
        ...proposal.metadata,
        outputProposal: {
          ...proposal.metadata.outputProposal,
          status: "accepted",
          decidedAt: "2026-07-23T12:05:00.000Z",
          decidedByUserId: "user-e2e",
        },
      },
    };
    let receivedDecision: Record<string, unknown> | undefined;

    await installMockComparativeApi(page, {
      artifactDetails: {
        [proposal.id]: {
          ...proposal,
          content: "# Weekly report\n\nLaunch risks and next steps.",
        },
      },
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-proposal-report",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: "The scheduled report update is ready for review.",
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-proposal-report",
            artifacts: [proposal],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
      onArtifactProposal: async (artifactId, body, route) => {
        expect(artifactId).toBe(proposal.id);
        receivedDecision = body;
        await json(route, { artifact: accepted });
      },
    });

    await gotoE2EChat(page);
    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Refresh the weekly report.");
    await page.getByRole("button", { name: "Send" }).click();

    const card = page.getByTestId("output-proposal-card");
    await expect(card).toContainText("Needs review");
    await expect(card).toContainText(
      "Updated the launch risks and next steps.",
    );
    await expect(card).toContainText("+3 -1 lines");
    await expect(page.getByTestId("artifact-pill")).toHaveCount(0);

    await card.getByRole("button", { name: "Preview" }).click();
    await expect(
      page.getByRole("complementary", { name: "Artifact preview" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close preview" }).click();

    await card.getByRole("button", { name: "Accept" }).click();
    await expect.poll(() => receivedDecision).toEqual({
      decision: "accepted",
    });
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId("artifact-pill")).toContainText(
      "weekly-report.md",
    );
  });

  test("iterates an artifact proposal in place and preserves its source history", async ({
    page,
  }) => {
    const threadId = "thread-artifact-iteration";
    const source = {
      ...defaultArtifactSummary,
      id: "artifact-iteration-v1",
      title: "Weekly report",
      filename: "weekly-report.md",
      kind: "document",
      mimeType: "text/markdown",
      threadId,
      artifactGroupId: "artifact-iteration-group",
      versionNumber: 1,
      supersedesArtifactId: null,
      versionSummary: "Initial weekly report.",
      metadata: {
        outputProposal: {
          status: "proposed",
          runId: "source-run",
          triggerType: "scheduled",
          createdAt: "2026-07-23T12:00:00.000Z",
        },
      },
    };
    const replacement = {
      ...source,
      id: "artifact-iteration-v2",
      versionNumber: 2,
      supersedesArtifactId: source.id,
      versionSummary: "Added a concise risks section.",
      metadata: {
        outputProposal: {
          status: "proposed",
          runId: "iteration-run",
          triggerType: "scheduled",
          createdAt: "2026-07-23T12:05:00.000Z",
          iterationOf: {
            sourceArtifactId: source.id,
            sourceRunId: "source-run",
            feedbackMessageId: "iteration-feedback",
            requestedAt: "2026-07-23T12:04:00.000Z",
            requestedByUserId: "user-e2e",
          },
        },
      },
    };
    const superseded = {
      ...source,
      metadata: {
        outputProposal: {
          ...source.metadata.outputProposal,
          status: "superseded",
          decidedAt: "2026-07-23T12:05:00.000Z",
          decidedByUserId: "user-e2e",
          replacedByArtifactId: replacement.id,
        },
      },
    };
    const threadMessages: Record<string, unknown[]> = { [threadId]: [] };
    let iterationRequest: Record<string, unknown> | undefined;

    await installMockComparativeApi(page, {
      threadMessages,
      artifactDetails: {
        [source.id]: { ...source, content: "# Weekly report" },
        [replacement.id]: {
          ...replacement,
          content: "# Weekly report\n\n## Risks",
        },
      },
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          { type: "meta", threadId, modelId: "sonnet-4-6" },
          {
            type: "text-delta",
            delta: "The weekly report proposal is ready.",
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-source",
            artifacts: [source],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
      onProposalIteration: async (body, route) => {
        iterationRequest = body;
        threadMessages[threadId] = [
          userMessage({
            id: "user-source",
            content: "Refresh the weekly report.",
          }),
          assistantMessage({
            id: "assistant-source",
            content: "The weekly report proposal is ready.",
            artifacts: [superseded],
          }),
          userMessage({
            id: "iteration-feedback",
            content:
              "Iterate on weekly-report.md: Add a concise risks section.",
          }),
          assistantMessage({
            id: "assistant-replacement",
            content: "The revised proposal is ready.",
            artifacts: [replacement],
          }),
        ];
        await fulfillSse(route, [
          {
            type: "meta",
            threadId,
            runId: "iteration-run",
            userMessageId: "iteration-feedback",
            modelId: "sonnet-4-6",
            runtimeRoute: { lane: "durable-local", useWorker: true },
          },
          {
            type: "queued",
            threadId,
            runId: "iteration-run",
            status: "Iterating on proposal",
          },
          { type: "done", stopReason: "queued" },
        ]);
      },
    });

    await gotoE2EChat(page);
    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Refresh the weekly report.");
    await page.getByRole("button", { name: "Send" }).click();

    const sourceCard = page
      .getByTestId("output-proposal-card")
      .filter({ hasText: "weekly-report.md" });
    await sourceCard.getByRole("button", { name: "Iterate" }).click();
    await sourceCard
      .getByLabel("Feedback for weekly-report.md")
      .fill("Add a concise risks section.");
    await sourceCard
      .getByRole("button", { name: "Submit iteration" })
      .click();

    await expect.poll(() => iterationRequest).toMatchObject({
      threadId,
      proposalIteration: {
        target: { kind: "artifact", artifactId: source.id },
        feedback: "Add a concise risks section.",
      },
    });
    await expect(
      page.getByText(
        "Iterate on weekly-report.md: Add a concise risks section.",
      ),
    ).toBeVisible();
    const cards = page.getByTestId("output-proposal-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.filter({ hasText: "Superseded" })).toContainText(
      "history is preserved",
    );
    const replacementCard = cards.filter({
      hasText: "Added a concise risks section.",
    });
    await expect(replacementCard).toContainText("Needs review");
    await expect(
      replacementCard.getByRole("button", { name: "Accept" }),
    ).toBeVisible();
  });

  test("iterates an app proposal without changing the live app", async ({
    page,
  }) => {
    const threadId = "thread-app-iteration";
    const appId = "app-iteration";
    const sourceVersionId = "app-version-v1";
    const replacementVersionId = "app-version-v2";
    const sourceArtifact = {
      ...defaultArtifactSummary,
      id: "app-artifact-v1",
      title: "Revenue Dashboard",
      filename: "revenue-dashboard.html",
      threadId,
      artifactGroupId: "app-artifact-group",
      versionNumber: 1,
      supersedesArtifactId: null,
      versionSummary: "Initial dashboard proposal.",
      metadata: {
        outputProposal: {
          status: "proposed",
          runId: "app-source-run",
          triggerType: "github_event",
          createdAt: "2026-07-23T12:00:00.000Z",
        },
      },
    };
    const replacementArtifact = {
      ...sourceArtifact,
      id: "app-artifact-v2",
      versionNumber: 2,
      supersedesArtifactId: sourceArtifact.id,
      versionSummary: "Made forecast variance easier to scan.",
      metadata: {
        outputProposal: {
          status: "proposed",
          runId: "app-iteration-run",
          triggerType: "github_event",
          createdAt: "2026-07-23T12:05:00.000Z",
        },
      },
    };
    const sourceVersion = {
      id: sourceVersionId,
      appId,
      appName: "Revenue Dashboard",
      appSlug: "revenue-dashboard",
      artifactId: sourceArtifact.id,
      versionNumber: 1,
      status: "proposed",
      canDeploy: true,
      previewUrl: `/api/apps/${appId}/versions/${sourceVersionId}/content`,
      liveUrl: "/apps/revenue-dashboard",
    };
    const replacementVersion = {
      ...sourceVersion,
      id: replacementVersionId,
      artifactId: replacementArtifact.id,
      versionNumber: 2,
    };
    const threadMessages: Record<string, unknown[]> = { [threadId]: [] };
    let iterationRequest: Record<string, unknown> | undefined;

    await installMockComparativeApi(page, {
      threadMessages,
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          { type: "meta", threadId, modelId: "sonnet-4-6" },
          { type: "text-delta", delta: "The app proposal is ready." },
          {
            type: "persisted",
            assistantMessageId: "assistant-app-source",
            artifacts: [sourceArtifact],
            appDraftVersions: [sourceVersion],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
      onProposalIteration: async (body, route) => {
        iterationRequest = body;
        threadMessages[threadId] = [
          userMessage({
            id: "user-app-source",
            content: "Review the dashboard proposal.",
          }),
          assistantMessage({
            id: "assistant-app-source",
            content: "The app proposal is ready.",
            artifacts: [
              {
                ...sourceArtifact,
                metadata: {
                  outputProposal: {
                    ...sourceArtifact.metadata.outputProposal,
                    status: "superseded",
                    replacedByArtifactId: replacementArtifact.id,
                  },
                },
              },
            ],
            appDraftVersions: [
              {
                ...sourceVersion,
                status: "superseded",
                canDeploy: false,
              },
            ],
          }),
          userMessage({
            id: "app-iteration-feedback",
            content:
              "Iterate on Revenue Dashboard: Make forecast variance easier to scan.",
          }),
          assistantMessage({
            id: "assistant-app-replacement",
            content: "The revised app proposal is ready.",
            artifacts: [replacementArtifact],
            appDraftVersions: [replacementVersion],
          }),
        ];
        await fulfillSse(route, [
          {
            type: "meta",
            threadId,
            runId: "app-iteration-run",
            userMessageId: "app-iteration-feedback",
            modelId: "sonnet-4-6",
            runtimeRoute: { lane: "durable-local", useWorker: true },
          },
          {
            type: "queued",
            threadId,
            runId: "app-iteration-run",
            status: "Iterating on proposal",
          },
          { type: "done", stopReason: "queued" },
        ]);
      },
    });

    await gotoE2EChat(page);
    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Review the dashboard proposal.");
    await page.getByRole("button", { name: "Send" }).click();

    const sourceCard = page
      .getByTestId("app-draft-card")
      .filter({ hasText: "Initial dashboard proposal." });
    await sourceCard.getByRole("button", { name: "Iterate" }).click();
    await sourceCard
      .getByLabel("Feedback for Revenue Dashboard")
      .fill("Make forecast variance easier to scan.");
    await sourceCard
      .getByRole("button", { name: "Submit iteration" })
      .click();

    await expect.poll(() => iterationRequest).toMatchObject({
      threadId,
      proposalIteration: {
        target: {
          kind: "app",
          appId,
          appVersionId: sourceVersionId,
        },
        feedback: "Make forecast variance easier to scan.",
      },
    });
    const cards = page.getByTestId("app-draft-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.filter({ hasText: "Superseded" })).toContainText(
      "live app has not changed",
    );
    const replacementCard = cards.filter({
      hasText: "Made forecast variance easier to scan.",
    });
    await expect(replacementCard).toContainText("Needs review");
    await expect(
      replacementCard.getByRole("button", { name: "Accept and publish" }),
    ).toBeVisible();
    await expect(
      replacementCard.getByRole("link", { name: "Open app" }),
    ).toHaveCount(0);
  });

  test("discards an unattended app proposal while preserving its history", async ({
    page,
  }) => {
    const threadId = "thread-app-proposal";
    const appId = "app-proposal";
    const versionId = "version-proposal-4";
    const proposal = {
      ...defaultArtifactSummary,
      id: "artifact-app-proposal",
      title: "Revenue Dashboard",
      filename: "revenue-dashboard.html",
      artifactGroupId: "revenue-dashboard",
      versionNumber: 4,
      supersedesArtifactId: "artifact-app-v3",
      versionSummary: "Added the forecast variance panel.",
      metadata: {
        lineDelta: { added: 12, removed: 2, approximate: false },
        outputProposal: {
          status: "proposed",
          runId: "run-app-proposal",
          triggerType: "github_event",
          createdAt: "2026-07-23T12:00:00.000Z",
        },
      },
    };
    const version = {
      id: versionId,
      appId,
      appName: "Revenue Dashboard",
      appSlug: "revenue-dashboard",
      artifactId: proposal.id,
      versionNumber: 4,
      status: "proposed",
      canDeploy: true,
      previewUrl: `/api/apps/${appId}/versions/${versionId}/content`,
      liveUrl: "/apps/revenue-dashboard",
    };
    const threadMessages: Record<string, unknown[]> = { [threadId]: [] };
    let receivedDiscard: Record<string, unknown> | undefined;

    await installMockComparativeApi(page, {
      threadMessages,
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          { type: "meta", threadId, modelId: "sonnet-4-6" },
          {
            type: "text-delta",
            delta: "The event-triggered app update is ready for review.",
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-app-proposal",
            artifacts: [proposal],
            appDraftVersions: [version],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
      onAppVersionPatch: async (
        receivedAppId,
        receivedVersionId,
        body,
        route,
      ) => {
        expect(receivedAppId).toBe(appId);
        expect(receivedVersionId).toBe(versionId);
        receivedDiscard = body;
        threadMessages[threadId] = [
          userMessage({
            id: "user-app-proposal",
            content: "Review the app proposal.",
          }),
          assistantMessage({
            id: "assistant-app-proposal",
            content: "The event-triggered app update is ready for review.",
            artifacts: [
              {
                ...proposal,
                metadata: {
                  ...proposal.metadata,
                  outputProposal: {
                    ...proposal.metadata.outputProposal,
                    status: "discarded",
                    reason: "Discarded during proposal review.",
                  },
                },
              },
            ],
            appDraftVersions: [
              { ...version, status: "discarded", canDeploy: false },
            ],
          }),
        ];
        await json(route, {
          version: { id: versionId, status: "discarded" },
        });
      },
    });

    await gotoE2EChat(page);
    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Review the app proposal.");
    await page.getByRole("button", { name: "Send" }).click();

    const card = page.getByTestId("app-draft-card");
    await expect(card).toContainText("Needs review");
    await expect(card).toContainText("live app has not changed");
    await expect(card).toContainText("+12 -2 lines");
    await card.getByRole("button", { name: "Discard" }).click();

    await expect.poll(() => receivedDiscard).toMatchObject({
      decision: "discarded",
    });
    await expect(card).toContainText("Discarded");
    await expect(card).toContainText("history is preserved");
    await expect(
      card.getByRole("button", { name: "Accept and publish" }),
    ).toHaveCount(0);
  });

  test("shows a completion title when a hidden-tab background run finishes", async ({
    page,
  }) => {
    const threadId = "thread-background-completion";
    const runId = "run-background-completion";
    const threadMessages: Record<string, unknown[]> = {
      [threadId]: [
        userMessage({
          id: "user-background",
          content: "Do this in the background",
        }),
        assistantMessage({
          id: `run:${runId}`,
          content: "",
          pending: true,
          status: "Working in background",
          runId,
          runStatus: "running",
          canCancel: true,
        }),
      ],
    };
    await installMockComparativeApi(page, {
      threadMessages,
      onChat: async (_body, route) => {
        setTimeout(() => {
          threadMessages[threadId] = [
            userMessage({
              id: "user-background",
              content: "Do this in the background",
            }),
            assistantMessage({
              id: "assistant-background",
              content: "Background answer is ready.",
              runId,
              runStatus: "succeeded",
            }),
          ];
        }, 900);
        await fulfillSse(route, [
          {
            type: "meta",
            threadId,
            runId,
            modelId: "sonnet-4-6",
            runtimeRoute: { useWorker: true },
          },
          {
            type: "queued",
            runId,
            status: "Working in background",
          },
          { type: "done", stopReason: "queued" },
        ]);
      },
    });
    await gotoE2EChat(page);
    const originalTitle = await page.title();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true,
      });
    });

    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Do this in the background");
    await page.getByRole("button", { name: "Send" }).click();
    await expect
      .poll(() => page.title(), { timeout: 8_000 })
      .toBe("✓ Done — Comparative");

    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => false,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => page.title()).toBe(originalTitle);
  });

  test("switches conversations from sidebar history without internal chat tabs", async ({
    page,
  }, testInfo) => {
    const isMobile = testInfo.project.name.includes("mobile");
    await installMockComparativeApi(page, {
      threads: [
        threadSummary("thread-alpha", "alpha sidebar question"),
        threadSummary("thread-beta", "beta sidebar question"),
      ],
      threadMessages: {
        "thread-alpha": [
          userMessage({ id: "user-alpha", content: "alpha sidebar question" }),
          assistantMessage({
            id: "assistant-alpha",
            content: "Alpha sidebar answer only.",
          }),
        ],
        "thread-beta": [
          userMessage({ id: "user-beta", content: "beta sidebar question" }),
          assistantMessage({
            id: "assistant-beta",
            content: "Beta sidebar answer only.",
          }),
        ],
      },
    });

    await gotoE2EChat(page);
    await expect(page.getByTestId("chat-tab-strip")).toHaveCount(0);

    let sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar
      .getByRole("button", { name: /alpha sidebar question/i })
      .click();
    const main = page.locator("main");
    await expect(main.getByText("Alpha sidebar answer only.")).toBeVisible();
    await expect(main.getByText("Beta sidebar answer only.")).toHaveCount(0);
    await expect(page.getByTestId("active-chat-title")).toContainText(
      "alpha sidebar question",
    );

    sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar
      .getByRole("button", { name: /beta sidebar question/i })
      .click();
    await expect(main.getByText("Beta sidebar answer only.")).toBeVisible();
    await expect(main.getByText("Alpha sidebar answer only.")).toHaveCount(0);
    await expect(page.getByTestId("active-chat-title")).toContainText(
      "beta sidebar question",
    );
  });

  test("opens existing app recommendations on the live share-aware app URL", async ({
    page,
  }) => {
    const recommendation = {
      dbId: "recommendation-open-app",
      id: "open-app:shared-dashboard",
      type: "open_existing_app",
      title: "Open Shared Dashboard",
      reason: "Shared Dashboard is shared with you and matches this request.",
      requiresApproval: false,
      action: {
        kind: "open_app",
        appId: "app-shared-dashboard",
        slug: "shared-dashboard",
      },
      metadata: {
        appId: "app-shared-dashboard",
        slug: "shared-dashboard",
        sharedWithMe: true,
      },
      status: "suggested",
      threadId: "thread-open-app",
      chatMessageId: "assistant-open-app",
      runId: "run-open-app",
      createdAt: "2026-06-14T20:00:00.000Z",
      updatedAt: "2026-06-14T20:00:00.000Z",
    };

    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-open-app",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: "You already have a matching app.",
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-open-app",
            artifacts: [],
            recommendations: [recommendation],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });
    await page.route("**/apps/shared-dashboard", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><body><h1>Shared Dashboard</h1></body></html>",
      });
    });

    await gotoE2EChat(page);
    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Open the shared dashboard app.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Open Shared Dashboard")).toBeVisible();
    await page.getByRole("button", { name: "Open app" }).click();
    await expect(page).toHaveURL(/\/apps\/shared-dashboard$/);
    await expect(
      page.getByRole("heading", { name: "Shared Dashboard" }),
    ).toBeVisible();
  });

  test("#322 iterates a published app twice, previews the latest draft, and publishes it inline", async ({
    page,
  }) => {
    const appId = "app-revenue-dashboard";
    const firstHtml =
      "<!doctype html><html><body><h1>Blue Revenue Dashboard</h1></body></html>";
    const latestHtml =
      "<!doctype html><html><body><h1>Blue Revenue Dashboard</h1><table><tr><th>Total</th><td>$42</td></tr></table></body></html>";
    const firstArtifact = {
      ...defaultArtifactSummary,
      id: "artifact-app-v2",
      title: "Revenue Dashboard v2",
      filename: "revenue-dashboard.html",
      artifactGroupId: "revenue-dashboard",
      versionNumber: 2,
      supersedesArtifactId: "artifact-app-v1",
      sizeBytes: firstHtml.length,
      previewUrl: "/api/workspace/artifacts/artifact-app-v2/preview",
      downloadUrl: "/api/workspace/artifacts/artifact-app-v2/download",
    };
    const latestArtifact = {
      ...firstArtifact,
      id: "artifact-app-v3",
      title: "Revenue Dashboard v3",
      versionNumber: 3,
      supersedesArtifactId: firstArtifact.id,
      sizeBytes: latestHtml.length,
      previewUrl: "/api/workspace/artifacts/artifact-app-v3/preview",
      downloadUrl: "/api/workspace/artifacts/artifact-app-v3/download",
    };
    const draftSummary = (
      id: string,
      artifactId: string,
      versionNumber: number,
    ) => ({
      id,
      appId,
      appName: "Revenue Dashboard",
      appSlug: "revenue-dashboard",
      artifactId,
      versionNumber,
      status: "draft",
      canDeploy: true,
      previewUrl: `/api/apps/${appId}/versions/${id}/content`,
      liveUrl: "/apps/revenue-dashboard",
    });
    let chatCount = 0;
    let deployedBody: Record<string, unknown> | undefined;

    await installMockComparativeApi(page, {
      artifacts: [latestArtifact, firstArtifact],
      artifactDetails: {
        [firstArtifact.id]: { ...firstArtifact, content: firstHtml },
        [latestArtifact.id]: { ...latestArtifact, content: latestHtml },
      },
      onChat: async (body, route) => {
        chatCount += 1;
        if (chatCount === 2) {
          expect(body.threadId).toBe("thread-app-edit");
        }
        const latest = chatCount === 2;
        const artifact = latest ? latestArtifact : firstArtifact;
        const versionId = latest ? "app-version-3" : "app-version-2";
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-app-edit",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: latest
              ? "Added the totals row and saved the latest draft."
              : "Updated the header and saved a draft.",
          },
          {
            type: "persisted",
            assistantMessageId: `assistant-app-edit-${chatCount}`,
            artifacts: [artifact],
            appDraftVersions: [
              draftSummary(versionId, artifact.id, artifact.versionNumber),
            ],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
      onAppDeploy: async (receivedAppId, body, route) => {
        expect(receivedAppId).toBe(appId);
        deployedBody = body;
        await json(route, {
          versionId: "app-version-3",
          url: "/apps/revenue-dashboard",
        });
      },
    });

    await gotoE2EChat(page);
    const composer = page.getByPlaceholder(/ask anything/i);
    await composer.fill("Make the app header blue.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("app-draft-card")).toContainText("v2");
    await expect(page.getByTestId("app-draft-card")).toContainText(
      "live app has not changed",
    );

    await composer.fill("Now add a totals row.");
    await page.getByRole("button", { name: "Send" }).click();

    const latestDraftCard = page.getByTestId("app-draft-card");
    await expect(latestDraftCard).toHaveCount(1);
    await expect(latestDraftCard).toContainText("v3");
    await expect(latestDraftCard).not.toContainText("v2");
    await expect(page.getByTestId("artifact-pill")).toHaveCount(2);

    await latestDraftCard.getByRole("button", { name: "Preview" }).click();
    const previewPane = page.getByRole("complementary", {
      name: "Artifact preview",
    });
    await expect(previewPane).toContainText("Revenue Dashboard v3");
    await expect(
      previewPane.frameLocator("iframe").getByRole("cell", { name: "$42" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close preview" }).click();

    await latestDraftCard
      .getByRole("button", { name: "Publish update" })
      .click();
    await expect(latestDraftCard).toContainText("Published");
    await expect(latestDraftCard).toContainText(
      "This version is now published.",
    );
    await expect(latestDraftCard.getByRole("link", { name: "Open app" })).toHaveAttribute(
      "href",
      "/apps/revenue-dashboard",
    );
    expect(deployedBody).toEqual({
      appVersionId: "app-version-3",
      dataMode: "snapshot",
    });
  });

  test("new chat replaces the active conversation instead of adding a tab", async ({
    page,
  }, testInfo) => {
    const isMobile = testInfo.project.name.includes("mobile");
    const chatBodies: Array<Record<string, unknown>> = [];

    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (body, route) => {
        chatBodies.push(body);
        const message = String(body.message ?? "");
        const isFirst = message.includes("first");
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: isFirst ? "thread-first" : "thread-second",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: isFirst ? "First chat answer." : "Second chat answer.",
          },
          {
            type: "persisted",
            assistantMessageId: `assistant-${chatBodies.length}`,
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await gotoE2EChat(page);
    await expect(page.getByTestId("chat-tab-strip")).toHaveCount(0);

    await page.getByPlaceholder(/ask anything/i).fill("first chat question");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("First chat answer.")).toBeVisible();

    const sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();
    await expect(page.getByText("First chat answer.")).toHaveCount(0);

    await page.getByPlaceholder(/ask anything/i).fill("second chat question");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Second chat answer.")).toBeVisible();
    await expect(page.getByText("First chat answer.")).toHaveCount(0);

    expect(chatBodies.map((body) => body.message)).toEqual([
      "first chat question",
      "second chat question",
    ]);
    expect(chatBodies[0]?.threadId).toBeUndefined();
    expect(chatBodies[1]?.threadId).toBeUndefined();
  });

  test("reload keeps one active route and history remains in the sidebar", async ({
    page,
  }, testInfo) => {
    const isMobile = testInfo.project.name.includes("mobile");
    await installMockComparativeApi(page, {
      artifacts: [],
      threads: [
        threadSummary("thread-persist-alpha", "alpha reload chat"),
        threadSummary("thread-persist-beta", "beta reload chat"),
      ],
      threadMessages: {
        "thread-persist-alpha": [
          userMessage({
            id: "user-persist-alpha",
            content: "alpha reload chat",
          }),
          assistantMessage({
            id: "assistant-persist-alpha",
            content: "Alpha persisted answer.",
          }),
        ],
        "thread-persist-beta": [
          userMessage({
            id: "user-persist-beta",
            content: "beta reload chat",
          }),
          assistantMessage({
            id: "assistant-persist-beta",
            content: "Beta persisted answer.",
          }),
          userMessage({
            id: "user-persist-beta-second",
            content: "beta second message",
          }),
          assistantMessage({
            id: "assistant-persist-beta-second",
            content: "Beta second persisted answer.",
          }),
        ],
      },
    });

    await gotoE2EChat(page);
    let sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar.getByRole("button", { name: /beta reload chat/i }).click();
    await expect(page.getByText("Beta persisted answer.")).toBeVisible();

    // #664: reload restores the beta thread from the URL instead of a blank
    // chat; the sidebar can still switch to another thread afterwards.
    await page.reload();
    await expect(page.getByTestId("chat-tab-strip")).toHaveCount(0);
    await expect(page.getByText("Beta persisted answer.")).toBeVisible();

    sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar.getByRole("button", { name: /alpha reload chat/i }).click();
    await expect(page.getByText("Alpha persisted answer.")).toBeVisible();
    await expect(page.getByText("Beta persisted answer.")).toHaveCount(0);
  });

  test("surfaces chat errors and retries the failed prompt", async ({ page }) => {
    let attempts = 0;
    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (_body, route) => {
        attempts += 1;
        if (attempts === 1) {
          await json(route, { error: "temporary bedrock failure" }, 500);
          return;
        }
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-retry",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: "Retried successfully.",
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-retry",
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await gotoE2EChat(page);
    await page.getByPlaceholder(/ask anything/i).fill("retry this prompt");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Error", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("Retried successfully.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(
      0,
    );
    expect(attempts).toBe(2);
  });

  test("submits alpha feedback with current chat context", async ({ page }) => {
    let feedbackBody: Record<string, unknown> | undefined;
    await installMockComparativeApi(page, {
      artifacts: [],
      onFeedback: async (body, route) => {
        feedbackBody = body;
        await json(
          route,
          {
            report: {
              id: "00000000-0000-4000-8000-000000000501",
              status: "new",
              createdAt: "2026-06-14T20:00:00.000Z",
            },
          },
          201,
        );
      },
    });

    await gotoE2EChat(page);
    await page.getByPlaceholder(/ask anything/i).fill("feedback context setup");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Done.")).toBeVisible();

    const feedbackNav = page.locator('[data-tour="nav-feedback"]');
    const openMenu = page.getByRole("button", { name: "Open menu" });
    if (await openMenu.isVisible()) {
      await openMenu.click();
      await expect(feedbackNav).toBeInViewport();
    }
    await feedbackNav.click();
    await expect(
      page.getByRole("dialog", { name: "Report feedback" }),
    ).toBeVisible();
    await page
      .getByLabel("What happened")
      .fill("The artifact preview opened a blank pane.");
    await page
      .getByLabel("Expected behavior")
      .fill("The preview pane should render the generated artifact.");
    await page.getByRole("button", { name: "Send feedback" }).click();

    await expect(page.getByText(/feedback sent/i)).toBeVisible();
    expect(feedbackBody).toMatchObject({
      type: "bug",
      severity: "normal",
      body: "The artifact preview opened a blank pane.",
      expected: "The preview pane should render the generated artifact.",
      includeContext: true,
    });
    expect(feedbackBody?.context).toMatchObject({
      threadId: "thread-generated",
      threadTitle: "feedback context setup",
      messageId: "assistant-generated",
      messagePreview: "Done.",
    });
  });

  test("accepts 5 MB feedback screenshots and rejects larger images", async ({
    page,
  }) => {
    let feedbackBody: Record<string, unknown> | undefined;
    await installMockComparativeApi(page, {
      artifacts: [],
      onFeedback: async (body, route) => {
        feedbackBody = body;
        await json(
          route,
          {
            report: {
              id: "00000000-0000-4000-8000-000000000502",
              status: "new",
              createdAt: "2026-06-14T20:00:00.000Z",
            },
          },
          201,
        );
      },
    });

    await gotoE2EChat(page);
    const feedbackNav = page.locator('[data-tour="nav-feedback"]');
    const openMenu = page.getByRole("button", { name: "Open menu" });
    if (await openMenu.isVisible()) {
      await openMenu.click();
      await expect(feedbackNav).toBeInViewport();
    }
    await feedbackNav.click();
    const dialog = page.getByRole("dialog", { name: "Report feedback" });
    await expect(dialog).toBeVisible();

    const fileInput = dialog.locator(
      'input[type="file"][accept="image/png,image/jpeg,image/gif,image/webp"]',
    );
    await fileInput.setInputFiles({
      name: "too-large.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
    });
    await expect(
      page.getByText("Screenshot is too large. Keep it under 5 MB."),
    ).toBeVisible();

    await fileInput.setInputFiles({
      name: "five-megabytes.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(5 * 1024 * 1024),
    });
    await expect(page.getByText(/five-megabytes\.png · remove/)).toBeVisible();
    await expect(
      page.getByText("Screenshot is too large. Keep it under 5 MB."),
    ).toHaveCount(0);

    await page
      .getByLabel("What happened")
      .fill("The feedback screenshot upload should work.");
    await page.getByRole("button", { name: "Send feedback" }).click();

    await expect(page.getByText(/feedback sent/i)).toBeVisible();
    expect(feedbackBody).toMatchObject({
      body: "The feedback screenshot upload should work.",
      screenshotName: "five-megabytes.png",
      screenshotMimeType: "image/png",
    });
    expect(String(feedbackBody?.screenshotDataUrl ?? "")).toMatch(
      /^data:image\/png;base64,/,
    );
  });
  test("renders server-reconciled app draft payloads: live non-deployable, superseded inert, later draft actionable (#344)", async ({
    page,
  }, testInfo) => {
    const isMobile = testInfo.project.name.includes("mobile");
    const appId = "app-reconciled";
    const reconciled = (
      id: string,
      versionNumber: number,
      status: string,
      canDeploy: boolean,
    ) => ({
      id,
      appId,
      appName: "Revenue Dashboard",
      appSlug: "revenue-dashboard",
      artifactId: `artifact-${id}`,
      versionNumber,
      status,
      canDeploy,
      previewUrl: `/api/apps/${appId}/versions/${id}/content`,
      liveUrl: "/apps/revenue-dashboard",
    });
    await installMockComparativeApi(page, {
      artifacts: [],
      threads: [
        threadSummary("thread-deployed-only", "deployed dashboard chat"),
        threadSummary("thread-later-draft", "later draft chat"),
      ],
      threadMessages: {
        // A1: the live version rehydrates as Live and non-deployable.
        "thread-deployed-only": [
          userMessage({ id: "u-reconciled-1", content: "edit my dashboard" }),
          assistantMessage({
            id: "a-reconciled-1",
            content: "Deployed earlier.",
            appDraftVersions: [reconciled("app-version-2", 2, "deployed", false)],
          }),
        ],
        // A2: superseded (reverted) version + later draft — only the draft
        // is actionable, and the reverted card must not read as a draft.
        "thread-later-draft": [
          userMessage({ id: "u-reconciled-2", content: "edit again" }),
          assistantMessage({
            id: "a-reconciled-2",
            content: "Reverted v1.",
            appDraftVersions: [
              {
                ...reconciled("app-version-1", 1, "reverted", false),
                appId: "app-superseded",
                appName: "Legacy Dashboard",
                appSlug: "legacy-dashboard",
                liveUrl: "/apps/legacy-dashboard",
              },
            ],
          }),
          userMessage({ id: "u-reconciled-2b", content: "deploy v2" }),
          assistantMessage({
            id: "a-reconciled-2b",
            content: "Deployed v2.",
            appDraftVersions: [reconciled("app-version-2", 2, "deployed", false)],
          }),
          userMessage({ id: "u-reconciled-3", content: "one more tweak" }),
          assistantMessage({
            id: "a-reconciled-3",
            content: "Draft v3 saved.",
            appDraftVersions: [reconciled("app-version-3", 3, "draft", true)],
          }),
        ],
      },
    });

    await gotoE2EChat(page);
    let sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar
      .getByRole("button", { name: /deployed dashboard chat/i })
      .click();
    const liveCard = page.getByTestId("app-draft-card");
    await expect(liveCard).toHaveCount(1);
    await expect(liveCard).toContainText("Published");
    await expect(liveCard).toContainText("This version is now published.");
    await expect(
      liveCard.getByRole("button", { name: "Publish update" }),
    ).toHaveCount(0);
    await expect(liveCard.getByRole("link", { name: "Open app" })).toHaveAttribute(
      "href",
      "/apps/revenue-dashboard",
    );

    await page.reload();
    sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar.getByRole("button", { name: /later draft chat/i }).click();
    const cards = page.getByTestId("app-draft-card");
    await expect(cards).toHaveCount(2);

    const supersededCard = cards.filter({ hasText: "Legacy Dashboard" });
    await expect(supersededCard).toContainText("Superseded");
    await expect(supersededCard).toContainText(
      "This version is no longer published.",
    );
    await expect(
      supersededCard.getByRole("button", { name: "Publish update" }),
    ).toHaveCount(0);
    await expect(supersededCard).not.toContainText("Ready for an owner to deploy");

    const draftCard = cards.filter({ hasText: "Revenue Dashboard" });
    await expect(draftCard).toHaveCount(1);
    await expect(draftCard).toContainText("v3");
    await expect(draftCard).not.toContainText("v2");
    await expect(
      draftCard.getByRole("button", { name: "Publish update" }),
    ).toBeVisible();
  });
});
