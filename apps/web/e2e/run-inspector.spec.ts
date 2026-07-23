import { expect, test } from "@playwright/test";
import {
  fulfillSse,
  installMockComparativeApi,
  now,
  regularUser,
} from "./helpers/mock-comparative";
import { gotoE2EChat } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked Run Inspector tests run only against the local e2e harness",
);

const runId = "11111111-1111-4111-8111-111111111361";

function runTrace(reasoningState: "available" | "absent" = "available") {
  const reasoningBlocks =
    reasoningState === "available"
      ? [
          {
            iteration: 0,
            blockIndex: 0,
            text: "I should inspect the connected repository first.",
            redacted: false,
          },
        ]
      : [];
  return {
    schema: "run-inspector.v1",
    generatedAt: now,
    run: {
      id: runId,
      status: "succeeded",
      skillSlug: "chat-turn",
      triggerType: "chat",
      runtime: "bedrock",
      modelId: "sonnet-4-6",
      actorEmail: "rob@example.com",
      actorName: "Rob",
      attemptCount: 1,
      inputs: {
        contextReceipt: { vault: { included: true } },
        runtimeRoute: { lane: "tool-local", reason: "github intent" },
      },
      outputs: {
        assistantText: "I inspected the repository and found the answer.",
        modelId: "sonnet-4-6",
        providerModelId: "us.anthropic.claude-sonnet-4-6-v1:0",
        runtimeTarget: "local",
        metrics: {
          requestToFirstTokenMs: 410,
          requestToCompletedMs: 1_240,
        },
        tokensIn: 420,
        tokensOut: 86,
      },
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    events: [
      {
        id: "trace-context",
        sequence: 1,
        eventType: "provider_context_snapshot",
        status: "succeeded",
        label: "Captured provider request context",
        provider: "bedrock",
        output: {
          requests: [
            {
              requestHash: "abcdef0123456789",
              request: {
                systemPrompt: "Use connected tools when the request needs them.",
                messages: [
                  { role: "user", content: [{ kind: "text", text: "Inspect it" }] },
                ],
                tools: [{ name: "github_search", description: "Search GitHub" }],
              },
            },
          ],
        },
        occurredAt: now,
      },
      {
        id: "trace-reasoning",
        sequence: 2,
        eventType: "provider_reasoning",
        status: reasoningState === "available" ? "succeeded" : "info",
        label:
          reasoningState === "available"
            ? "Captured provider reasoning"
            : "Provider returned no inspectable reasoning",
        provider: "bedrock",
        output: { state: reasoningState, blocks: reasoningBlocks },
        occurredAt: now,
      },
      {
        id: "trace-tool-call",
        sequence: 3,
        eventType: "tool_call",
        status: "succeeded",
        label: "Called GitHub search",
        provider: "github",
        toolName: "github_search",
        input: { query: "repo:example/comparative is:pr" },
        occurredAt: now,
      },
      {
        id: "trace-tool-result",
        sequence: 4,
        eventType: "tool_result",
        status: "succeeded",
        label: "GitHub search completed",
        provider: "github",
        toolName: "github_search",
        output: { count: 3 },
        occurredAt: now,
      },
      {
        id: "trace-metadata",
        sequence: 5,
        eventType: "provider_response_metadata",
        status: "succeeded",
        label: "Captured provider response metadata",
        provider: "bedrock",
        output: { responses: [{ stopReason: "end_turn", latencyMs: 812 }] },
        occurredAt: now,
      },
    ],
    auditEvents: [],
  };
}

test.describe("admin Run Inspector", () => {
  test("opens beside chat, exposes trace tabs, and resizes", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page, {
      runTraces: { [runId]: runTrace() },
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-inspector",
            runId,
            modelId: "sonnet-4-6",
          },
          {
            type: "provider-reasoning-delta",
            iteration: 0,
            blockIndex: 0,
            delta: "I should inspect the connected repository first.",
          },
          {
            type: "text-delta",
            delta: "I inspected the repository and found the answer.",
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-inspector",
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });
    await gotoE2EChat(page);

    await page.getByPlaceholder(/ask anything/i).fill("Inspect the repository");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText("I inspected the repository and found the answer."),
    ).toBeVisible();

    const chatPane = page.getByTestId("chat-workspace-pane");
    const chatWidthBefore = await chatPane.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    await page.getByRole("button", { name: "Inspect run" }).click();
    const inspector = page.getByRole("complementary", {
      name: "Run Inspector",
    });
    await expect(inspector).toBeVisible();
    await expect(inspector.getByText("sonnet-4-6").first()).toBeVisible();

    if (!isMobile) {
      const chatWidthAfter = await chatPane.evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      expect(chatWidthAfter).toBeLessThan(chatWidthBefore - 100);

      const resizer = page.getByTestId("run-inspector-resizer");
      const widthBefore = await inspector.evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      await resizer.press("Shift+ArrowLeft");
      const widthAfter = await inspector.evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      expect(widthAfter).toBeGreaterThan(widthBefore + 60);
    }

    await inspector.getByRole("tab", { name: "Timeline" }).click();
    await expect(inspector.getByText("Called GitHub search")).toBeVisible();
    await inspector.getByRole("tab", { name: "Context" }).click();
    await inspector.getByText("Provider request 1").click();
    await expect(inspector.getByText("Use connected tools")).toBeVisible();
    await inspector.getByRole("tab", { name: "Reasoning" }).click();
    await expect(
      inspector.getByText("I should inspect the connected repository first."),
    ).toBeVisible();
    await inspector.getByRole("tab", { name: "Tools" }).click();
    await expect(inspector.getByText("GitHub search completed")).toBeVisible();
    await inspector.getByRole("tab", { name: "Raw" }).click();
    await expect(inspector.getByText("run-inspector.v1")).toBeVisible();

    await page.getByRole("button", { name: "Close Run Inspector" }).click();
    await expect(inspector).toHaveCount(0);
  });

  test("does not expose the inspector affordance to a non-admin", async ({
    page,
  }) => {
    await installMockComparativeApi(page, {
      user: regularUser,
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-user-run",
            runId,
            modelId: "sonnet-4-6",
          },
          { type: "text-delta", delta: "Finished the user request." },
          {
            type: "persisted",
            assistantMessageId: "assistant-user-run",
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });
    await gotoE2EChat(page);

    await page.getByPlaceholder(/ask anything/i).fill("Run this for me");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Finished the user request.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Inspect run" })).toHaveCount(
      0,
    );
  });
});
