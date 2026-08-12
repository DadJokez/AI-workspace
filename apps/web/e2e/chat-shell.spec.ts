import { expect, test } from "@playwright/test";
import {
  assistantMessage,
  fulfillSse,
  installMockComparativeApi,
  userMessage,
} from "./helpers/mock-comparative";
import { gotoE2EChat, openPrimarySidebar } from "./helpers/navigation";
import { swipe } from "./helpers/swipe";
import { COMPARATIVE_VERSION_LABEL } from "../lib/product-version";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked chat shell tests run only against the local e2e harness",
);

test.describe("chat shell guardrails", () => {
  test("shows a prominent Comparative mark on the empty chat landing page", async ({
    page,
  }, testInfo) => {
    await installMockComparativeApi(page);

    await gotoE2EChat(page);

    const landingOrb = page.locator('main svg[aria-label="Comparative"]');
    await expect(landingOrb).toBeVisible();
    await expect(landingOrb).toHaveAttribute("width", "176");
    await expect(landingOrb).toHaveAttribute("height", "176");
    await expect(
      page.locator("main").getByText(COMPARATIVE_VERSION_LABEL),
    ).toBeVisible();
    if (!testInfo.project.name.includes("mobile")) {
      await expect(
        page
          .locator('aside[aria-label="Primary"]')
          .getByText(COMPARATIVE_VERSION_LABEL),
      ).toBeVisible();
    }
  });

  test("personalizes the greeting, connected tools, and role-aware prompts", async ({
    page,
  }) => {
    await installMockComparativeApi(page, {
      user: {
        displayName: "Rob Lindmark",
        customInstructions: "My role: Engineering.",
      },
      oauthStatus: { github: true },
      recommendationPrompts: {
        connectedProviders: ["github"],
        suggestions: [
          "Review my open GitHub work and tell me what to tackle first",
          "Turn these technical notes into a clear team update",
          "Draft release notes from this list of changes",
          "Break this technical problem into the next concrete steps",
        ],
      },
    });

    await gotoE2EChat(page);

    await expect(page.getByTestId("empty-state-greeting")).toHaveText(
      /Good (morning|afternoon|evening), Rob\./,
    );
    await expect(page.getByText("GitHub is connected.")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Review my open GitHub work and tell me what to tackle first",
      }),
    ).toBeVisible();
  });

  test("falls back to useful prompts when recommendations are unavailable", async ({
    page,
  }) => {
    await installMockComparativeApi(page, {
      recommendationPromptsStatus: 503,
      oauthStatus: { github: false },
    });

    await gotoE2EChat(page);

    await expect(
      page.getByRole("button", {
        name: "Draft a concise project status update for my team",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("No work tools are connected yet."),
    ).toBeVisible();
  });

  test("recovers the composer when model bootstrap fails", async ({ page }) => {
    await installMockComparativeApi(page);
    let modelRequests = 0;
    await page.route("**/api/models", async (route) => {
      modelRequests += 1;
      if (modelRequests === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporarily_unavailable" }),
        });
        return;
      }
      await route.fallback();
    });

    await gotoE2EChat(page, { waitForComposer: false });

    const alert = page.getByTestId("models-load-error");
    await expect(alert).toContainText("Comparative couldn't start.");
    await expect(
      page.getByPlaceholder("Comparative is unavailable"),
    ).toBeDisabled();

    await alert.getByRole("button", { name: "Retry" }).click();

    await expect(alert).toHaveCount(0);
    await expect(page.getByPlaceholder(/ask anything/i)).toBeEnabled();
    expect(modelRequests).toBe(2);
  });

  test("shows conversation-shaped skeletons while saved messages load", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page, {
      threads: [
        {
          id: "thread-slow-history",
          title: "Slow history",
          defaultModelId: "sonnet-4-6",
          summary: null,
          summaryUpdatedAt: null,
          previewSummary: null,
          previewSummaryUpdatedAt: null,
          titleSource: "generated",
          createdAt: "2026-07-21T12:00:00.000Z",
          updatedAt: "2026-07-21T12:00:00.000Z",
        },
      ],
      threadMessages: {
        "thread-slow-history": [
          assistantMessage({
            id: "assistant-slow-history",
            content: "The saved conversation is ready.",
          }),
        ],
      },
      threadMessagesDelayMs: 800,
    });
    await gotoE2EChat(page);

    const sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar.getByRole("button", { name: "Slow history" }).click();

    await expect(page.getByTestId("thread-loading-skeleton")).toBeVisible();
    await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);
    await expect(page.getByText("The saved conversation is ready.")).toBeVisible();
    await expect(page.getByTestId("thread-loading-skeleton")).toHaveCount(0);
  });

  test("blocks empty and whitespace-only submits", async ({ page }) => {
    let chatCalls = 0;
    await installMockComparativeApi(page, {
      onChat: async (_body, route) => {
        chatCalls += 1;
        await fulfillSse(route, [
          { type: "meta", threadId: "thread-empty", modelId: "sonnet-4-6" },
          { type: "text-delta", delta: "This should not be sent." },
          {
            type: "persisted",
            assistantMessageId: "assistant-empty",
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await gotoE2EChat(page);
    await expect(
      page.getByText("No work tools are connected yet."),
    ).toBeVisible();

    const input = page.getByPlaceholder(/ask anything/i);
    const send = page.getByRole("button", { name: "Send" });

    await expect(send).toBeDisabled();
    await input.fill("   ");
    await expect(send).toBeDisabled();
    await input.press("Enter");

    expect(chatCalls).toBe(0);
    await expect(page.getByText("This should not be sent.")).toHaveCount(0);
  });

  test("restores a composer draft after reload and clears it on send", async ({
    page,
  }) => {
    await installMockComparativeApi(page);
    await gotoE2EChat(page);

    const draft = "Keep this half-written launch update for me";
    const input = page.getByPlaceholder(/ask anything/i);
    await input.fill(draft);
    // Reload immediately, before the 250 ms debounce, to exercise pagehide
    // flushing rather than merely reading an already-persisted draft.
    await page.reload();
    await expect(page.getByPlaceholder(/ask anything/i)).toHaveValue(draft);

    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Done.")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(window.localStorage).filter((key) =>
            key.startsWith("comparative-chat-draft:"),
          ),
        ),
      )
      .toEqual([]);
  });

  test("copies an assistant message as raw markdown", async ({
    page,
    context,
  }) => {
    const rawMarkdown =
      "A **bold status** with [the launch doc](https://example.com/launch).";
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await installMockComparativeApi(page, {
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          { type: "meta", threadId: "thread-copy", modelId: "sonnet-4-6" },
          { type: "text-delta", delta: rawMarkdown },
          {
            type: "persisted",
            assistantMessageId: "assistant-copy",
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });
    await gotoE2EChat(page);

    await page.getByPlaceholder(/ask anything/i).fill("Draft my update");
    await page.getByRole("button", { name: "Send" }).click();
    const message = page
      .getByTestId("assistant-message")
      .filter({ hasText: "A bold status" });
    await expect(message).toBeVisible();
    await message.hover();
    await message.getByRole("button", { name: "Copy message" }).click();
    await expect(
      message.getByRole("button", { name: "Copied message" }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(rawMarkdown);
  });

  test("renders user code, links, and literal brackets through the restricted markdown pipeline", async ({
    page,
  }, testInfo) => {
    const prompt = [
      "Please review `inlineValue` and this block:",
      "```js",
      "const answer = 42;",
      "```",
      "[Reference](https://example.com/reference)",
      "C4V07A|<customer>|<revenue>",
      "Array<string>",
      "<order><id>42</id></order>",
      "3 < 5 and 8 > 2",
      "# This stays compact",
      "| Unsafe | table |",
      "| --- | --- |",
      '<img src="x" onerror="window.__userMarkdownXss = true">',
    ].join("\n");
    await installMockComparativeApi(page, {
      threads: [
        {
          id: "thread-literal-brackets",
          title: "Literal bracket prompt",
          defaultModelId: "sonnet-4-6",
          summary: null,
          summaryUpdatedAt: null,
          previewSummary: null,
          previewSummaryUpdatedAt: null,
          titleSource: "auto",
          createdAt: "2026-06-14T20:00:00.000Z",
          updatedAt: "2026-06-14T20:00:00.000Z",
        },
      ],
      threadMessages: {
        "thread-literal-brackets": [
          userMessage({ id: "user-literal-brackets", content: prompt }),
          assistantMessage({
            id: "assistant-literal-brackets",
            content: "Literal placeholders preserved.",
          }),
        ],
      },
    });
    await gotoE2EChat(page);

    const composer = page.getByPlaceholder(/ask anything/i);
    await composer.fill(prompt);
    await expect(composer).toHaveValue(prompt);
    await page.getByRole("button", { name: "Send" }).click();

    const message = page.getByTestId("user-message").last();
    await expect(message.getByText("inlineValue", { exact: true })).toBeVisible();
    await expect(message.locator("pre code")).toContainText(
      "const answer = 42;",
    );
    await expect(
      message.getByRole("link", { name: "Reference" }),
    ).toHaveAttribute("href", "https://example.com/reference");
    await expect(message).toContainText("C4V07A|<customer>|<revenue>");
    await expect(message).toContainText("Array<string>");
    await expect(message).toContainText("<order><id>42</id></order>");
    await expect(message).toContainText("3 < 5 and 8 > 2");
    await expect(message).toContainText(
      '<img src="x" onerror="window.__userMarkdownXss = true">',
    );
    await expect(message.locator("h1, table, img")).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { __userMarkdownXss?: boolean })
            .__userMarkdownXss,
      ),
    ).toBeUndefined();

    await page.reload();
    const sidebar = await openPrimarySidebar(
      page,
      testInfo.project.name.includes("mobile"),
    );
    await sidebar
      .getByRole("button", { name: /literal bracket prompt/i })
      .click();
    const persisted = page
      .getByTestId("user-message")
      .filter({ hasText: "C4V07A|<customer>|<revenue>" });
    await expect(persisted).toContainText("C4V07A|<customer>|<revenue>");
    await expect(persisted).toContainText("Array<string>");
    await expect(persisted).toContainText("<order><id>42</id></order>");
  });

  test("edits and resends a prior user message on the same thread", async ({
    page,
  }) => {
    const chatBodies: Array<Record<string, unknown>> = [];
    await installMockComparativeApi(page, {
      onChat: async (body, route) => {
        chatBodies.push(body);
        const turn = chatBodies.length;
        const sourceMessageIds = [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
        ];
        const userMessageId =
          typeof body.replaceMessageId === "string"
            ? body.replaceMessageId
            : sourceMessageIds[turn - 1];
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-edit",
            userMessageId,
            modelId: "sonnet-4-6",
          },
          { type: "text-delta", delta: `Answer ${turn}.` },
          {
            type: "persisted",
            assistantMessageId: `assistant-edit-${turn}`,
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });
    await gotoE2EChat(page);

    const input = page.getByPlaceholder(/ask anything/i);
    await input.fill("Draft the old launch update");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Answer 1.")).toBeVisible();
    await input.fill("Add a closing line");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Answer 2.")).toBeVisible();

    await input.fill("Keep this separate draft");
    const firstMessage = page
      .getByTestId("user-message")
      .filter({ hasText: "Draft the old launch update" });
    await firstMessage.hover();
    await firstMessage.getByRole("button", { name: "Edit message" }).click();
    await expect(page.getByTestId("edit-message-state")).toBeVisible();
    await expect(input).toHaveValue("Draft the old launch update");
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.entries(window.localStorage)
            .filter(([key]) => key.startsWith("comparative-chat-draft:"))
            .map(([, value]) => value),
        ),
      )
      .toContain("Keep this separate draft");
    await page
      .getByRole("button", { name: "Cancel editing message" })
      .click();
    await expect(input).toHaveValue("Keep this separate draft");

    await firstMessage.getByRole("button", { name: "Edit message" }).click();
    await input.fill("Draft the corrected launch update");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Answer 3.")).toBeVisible();
    await expect(page.getByText("Answer 1.")).toHaveCount(0);
    await expect(page.getByText("Add a closing line")).toHaveCount(0);
    await expect(page.getByText("Answer 2.")).toHaveCount(0);
    expect(chatBodies).toHaveLength(3);
    expect(chatBodies[2]).toMatchObject({
      message: "Draft the corrected launch update",
      threadId: "thread-edit",
    });
    expect(chatBodies[2]!.replaceMessageId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  test("edits a hydrated message and keeps the replacement after reload", async ({
    page,
    isMobile,
  }) => {
    const threadId = "thread-hydrated-edit";
    const title = "Hydrated edit";
    const userMessageId = "44444444-4444-4444-8444-444444444444";
    const originalPrompt = "The deployment region is North.";
    const replacementPrompt = "The deployment region is South.";
    const threadMessages: Record<string, unknown[]> = {
      [threadId]: [
        userMessage({ id: userMessageId, content: originalPrompt }),
        assistantMessage({
          id: "assistant-hydrated-north",
          content: "The deployment region is North.",
        }),
      ],
    };
    const chatBodies: Array<Record<string, unknown>> = [];
    await installMockComparativeApi(page, {
      threads: [
        {
          id: threadId,
          title,
          defaultModelId: "sonnet-4-6",
          summary: null,
          summaryUpdatedAt: null,
          previewSummary: null,
          previewSummaryUpdatedAt: null,
          titleSource: "generated",
          createdAt: "2026-07-24T12:00:00.000Z",
          updatedAt: "2026-07-24T12:00:00.000Z",
        },
      ],
      threadMessages,
      onChat: async (body, route) => {
        chatBodies.push(body);
        threadMessages[threadId] = [
          userMessage({ id: userMessageId, content: replacementPrompt }),
          assistantMessage({
            id: "assistant-hydrated-south",
            content: "The deployment region is South.",
          }),
        ];
        await fulfillSse(route, [
          {
            type: "meta",
            threadId,
            userMessageId,
            modelId: "sonnet-4-6",
          },
          { type: "text-delta", delta: "The deployment region is South." },
          {
            type: "persisted",
            assistantMessageId: "assistant-hydrated-south",
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await gotoE2EChat(page);
    const sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar.getByRole("button", { name: title }).click();
    await expect(page.getByTestId("user-message")).toContainText(originalPrompt);

    // #664: the URL identifies the open thread, so reload restores it.
    await expect(page).toHaveURL(new RegExp(`threadId=${threadId}`));
    await page.reload();
    const originalMessage = page
      .getByTestId("user-message")
      .filter({ hasText: originalPrompt });
    await expect(originalMessage).toBeVisible();
    await originalMessage.hover();
    await originalMessage.getByRole("button", { name: "Edit message" }).click();

    const input = page.getByPlaceholder(/ask anything/i);
    await expect(input).toHaveValue(originalPrompt);
    await input.fill(replacementPrompt);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("The deployment region is South.").last()).toBeVisible();
    expect(chatBodies).toEqual([
      expect.objectContaining({
        message: replacementPrompt,
        threadId,
        replaceMessageId: userMessageId,
      }),
    ]);

    await page.reload();
    await expect(
      page.getByTestId("user-message").filter({ hasText: replacementPrompt }),
    ).toBeVisible();
    await expect(
      page.getByTestId("user-message").filter({ hasText: originalPrompt }),
    ).toHaveCount(0);
    await expect(page.getByText("The deployment region is North.")).toHaveCount(
      0,
    );
  });

  // #348: file-bearing turns edit by replaying stored uploads. The image and
  // the Office-style document exercise both replay channels (native image
  // block + extracted text); the second thread pins the fail-closed side.
  test("regenerates and edits a file-bearing user message by replaying stored uploads", async ({
    page,
  }, testInfo) => {
    const isMobile = testInfo.project.name.includes("mobile");
    const fileMessageId = "33333333-3333-4333-8333-333333333333";
    const uploadArtifact = (
      id: string,
      overrides: Record<string, unknown>,
    ) => ({
      id,
      source: "user-upload",
      threadId: "thread-files",
      chatMessageId: fileMessageId,
      runId: null,
      artifactGroupId: id,
      versionNumber: 1,
      supersedesArtifactId: null,
      versionSummary: null,
      createdAt: "2026-06-14T20:00:00.000Z",
      updatedAt: "2026-06-14T20:00:00.000Z",
      ...overrides,
    });
    const chatBodies: Array<Record<string, unknown>> = [];
    await installMockComparativeApi(page, {
      artifacts: [],
      threads: [
        {
          id: "thread-files",
          title: "quarterly numbers",
          defaultModelId: "sonnet-4-6",
          summary: null,
          summaryUpdatedAt: null,
          previewSummary: null,
          previewSummaryUpdatedAt: null,
          titleSource: "generated",
          createdAt: "2026-06-14T20:00:00.000Z",
          updatedAt: "2026-06-14T20:00:00.000Z",
        },
        {
          id: "thread-broken-files",
          title: "legacy upload",
          defaultModelId: "sonnet-4-6",
          summary: null,
          summaryUpdatedAt: null,
          previewSummary: null,
          previewSummaryUpdatedAt: null,
          titleSource: "generated",
          createdAt: "2026-06-14T19:00:00.000Z",
          updatedAt: "2026-06-14T19:00:00.000Z",
        },
      ],
      threadMessages: {
        "thread-files": [
          userMessage({
            id: fileMessageId,
            content: "Summarize the attached numbers",
            artifacts: [
              uploadArtifact("upload-image", {
                title: "chart.png",
                filename: "chart.png",
                kind: "image",
                mimeType: "image/png",
                sizeBytes: 1024,
                metadata: {
                  uploadIndex: 0,
                  storageEncoding: "base64",
                  extractionStatus: "metadata_only",
                  extractedText: "PNG image, 640x480.",
                  image: { width: 640, height: 480 },
                },
              }),
              uploadArtifact("upload-doc", {
                title: "q2.docx",
                filename: "q2.docx",
                kind: "document",
                mimeType:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                sizeBytes: 2048,
                metadata: {
                  uploadIndex: 1,
                  storageEncoding: "base64",
                  extractionStatus: "extracted",
                  extractedText: "Q2 revenue grew 12%.",
                },
              }),
            ],
          }),
          assistantMessage({
            id: "assistant-files-1",
            content: "The numbers show growth.",
          }),
        ],
        "thread-broken-files": [
          userMessage({
            id: "44444444-4444-4444-8444-444444444444",
            content: "Legacy upload without replay data",
            artifacts: [
              uploadArtifact("upload-legacy", {
                title: "old.pdf",
                filename: "old.pdf",
                kind: "document",
                mimeType: "application/pdf",
                sizeBytes: 4096,
                metadata: { storageEncoding: "base64" },
              }),
            ],
          }),
          assistantMessage({
            id: "assistant-files-2",
            content: "Legacy answer.",
          }),
        ],
      },
      onChat: async (body, route) => {
        chatBodies.push(body);
        const turn = chatBodies.length;
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-files",
            userMessageId:
              typeof body.replaceMessageId === "string"
                ? body.replaceMessageId
                : "55555555-5555-4555-8555-555555555555",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta:
              turn === 1
                ? "Regenerated answer over the files."
                : "Revised answer over the files.",
          },
          {
            type: "persisted",
            assistantMessageId: `assistant-files-replay-${turn}`,
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });
    await gotoE2EChat(page);

    // Fail-closed side first: uploads without replay data keep follow-up-only.
    let sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar.getByRole("button", { name: /legacy upload/i }).click();
    const legacyMessage = page
      .getByTestId("user-message")
      .filter({ hasText: "Legacy upload without replay data" });
    await expect(legacyMessage).toBeVisible();
    await legacyMessage.hover();
    await expect(
      legacyMessage.getByRole("button", { name: "Edit message" }),
    ).toHaveCount(0);

    // Replayable side: image + document turn is editable.
    sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar.getByRole("button", { name: /quarterly numbers/i }).click();
    const fileMessage = page
      .getByTestId("user-message")
      .filter({ hasText: "Summarize the attached numbers" });
    await expect(fileMessage).toBeVisible();

    // #451: regenerate replays the persisted uploads server-side. Sending the
    // old attachment payload too would trip the 409 replay conflict guard.
    const fileAnswer = page
      .getByTestId("assistant-message")
      .filter({ hasText: "The numbers show growth." });
    await fileAnswer.hover();
    await fileAnswer
      .getByRole("button", { name: "Regenerate response" })
      .click();
    await expect(
      page.getByText("Regenerated answer over the files."),
    ).toBeVisible();
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({
      message: "Summarize the attached numbers",
      threadId: "thread-files",
      replaceMessageId: fileMessageId,
      attachmentCount: 0,
    });
    expect(chatBodies[0]!.attachments).toBeUndefined();

    await fileMessage.hover();
    await fileMessage.getByRole("button", { name: "Edit message" }).click();

    await expect(page.getByTestId("edit-message-state")).toBeVisible();
    await expect(page.getByTestId("edit-replay-note")).toContainText(
      "2 uploaded files will be re-sent unchanged",
    );

    const input = page.getByPlaceholder(/ask anything/i);
    await expect(input).toHaveValue("Summarize the attached numbers");
    await input.fill("Summarize the attached numbers by quarter");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(
      page.getByText("Revised answer over the files."),
    ).toBeVisible();
    await expect(
      page.getByText("Regenerated answer over the files."),
    ).toHaveCount(0);
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[1]).toMatchObject({
      message: "Summarize the attached numbers by quarter",
      threadId: "thread-files",
      replaceMessageId: fileMessageId,
    });
    // The replay sources files from storage — the edit request must not
    // carry a fresh attachments payload.
    expect(chatBodies[1]!.attachments).toBeUndefined();
    expect(chatBodies[1]!.attachmentCount).toBe(0);

    // Streaming-route regression (#405 review): the edited turn keeps its
    // file indicator and its re-edit affordance without any reload — the
    // optimistic bubble inherits the replaced message's attachment state.
    const editedMessage = page
      .getByTestId("user-message")
      .filter({ hasText: "Summarize the attached numbers by quarter" });
    await expect(editedMessage).toContainText("📎 2 files attached");
    await editedMessage.hover();
    await expect(
      editedMessage.getByRole("button", { name: "Edit message" }),
    ).toBeVisible();
  });

  test("sends suggestions and preserves manual multiline payloads", async ({
    page,
  }) => {
    const chatBodies: Array<Record<string, unknown>> = [];
    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (body, route) => {
        chatBodies.push(body);
        const response =
          chatBodies.length === 1
            ? "Suggestion answer streamed in."
            : "Multiline answer streamed in.";
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-continuity",
            modelId: "haiku-4-5",
          },
          { type: "text-delta", delta: response },
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

    const suggestions = [
      "Open GitHub issues assigned to me — what should I tackle first?",
      "Summarize what shipped in my repos this week",
      "Draft a concise project status update for my team",
      "What can you help me with today?",
    ];
    for (const suggestion of suggestions) {
      await expect(
        page.getByRole("button", { name: suggestion }),
      ).toBeVisible();
    }

    await page
      .getByRole("button", {
        name: "Draft a concise project status update for my team",
      })
      .click();
    const suggestionBubble = page
      .locator("main")
      .locator(".justify-end")
      .filter({
        hasText: "Draft a concise project status update for my team",
      });
    await expect(suggestionBubble).toBeVisible();
    await expect(page.getByText("Suggestion answer streamed in.")).toBeVisible();
    await expect(page.getByText("Thomas · haiku-4-5")).toBeVisible();

    const input = page.getByPlaceholder(/ask anything/i);
    await input.fill("line one");
    await input.press("Shift+Enter");
    await input.pressSequentially("line two");
    await expect(input).toHaveValue("line one\nline two");
    await input.press("Enter");

    const multilineBubble = page
      .locator("main")
      .locator(".whitespace-pre-wrap")
      .filter({ hasText: "line one\nline two" });
    await expect(multilineBubble).toBeVisible();
    await expect(multilineBubble).toHaveText("line one\nline two");
    await expect(page.getByText("Multiline answer streamed in.")).toBeVisible();
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[0]?.message).toBe(
      "Draft a concise project status update for my team",
    );
    expect(chatBodies[1]?.message).toBe("line one\nline two");
    expect(chatBodies[1]?.threadId).toBe("thread-continuity");
  });

  test("keeps short assistant answers from clipping on the left edge", async ({
    page,
  }) => {
    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-short-answer",
            modelId: "haiku-4-5",
          },
          { type: "text-delta", delta: "42." },
          {
            type: "persisted",
            assistantMessageId: "assistant-short-answer",
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await gotoE2EChat(page);
    const input = page.getByPlaceholder(/ask anything/i);
    await input.fill("what is the answer to the universe?");
    await input.press("Enter");

    const answer = page
      .getByTestId("assistant-message-content")
      .filter({ hasText: "42." })
      .last();
    await expect(answer).toBeVisible();
    await expect(answer).toContainText("42.");

    const paintBounds = await answer.evaluate((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const messageColumn = document
        .querySelector('[data-density="messages"]')
        ?.getBoundingClientRect();
      return {
        paddingLeft: Number.parseFloat(style.paddingLeft),
        paddingRight: Number.parseFloat(style.paddingRight),
        left: rect.left,
        columnLeft: messageColumn?.left ?? 0,
      };
    });

    await expect(answer.locator("ol")).toHaveCount(0);
    expect(paintBounds.paddingLeft).toBeGreaterThanOrEqual(1);
    expect(paintBounds.paddingRight).toBeGreaterThanOrEqual(1);
    expect(paintBounds.left).toBeGreaterThan(paintBounds.columnLeft);
  });

  test("keeps top-bar controls and theme persistence stable without chat tabs", async ({
    page,
  }, testInfo) => {
    let calls = 0;
    const chatBodies: Array<Record<string, unknown>> = [];
    let releaseFirstResponse: (() => void) | undefined;
    const firstResponseGate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });
    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (body, route) => {
        chatBodies.push(body);
        calls += 1;
        if (calls === 1) {
          await firstResponseGate;
        }
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-header-controls",
            userMessageId: "33333333-3333-4333-8333-333333333333",
            modelId: "sonnet-4-6",
          },
          { type: "text-delta", delta: `Shell response ${calls}.` },
          {
            type: "persisted",
            assistantMessageId: `assistant-header-${calls}`,
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await gotoE2EChat(page);
    await page.evaluate(() => window.localStorage.setItem("theme", "light"));
    await page.reload();
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();

    const header = page.locator("header").first();
    const isMobile = testInfo.project.name.includes("mobile");
    const openMenu = header.getByRole("button", { name: "Open menu" });
    if (isMobile) {
      await expect(openMenu).toBeVisible();
    } else {
      await expect(openMenu).toBeHidden();
    }

    await expect(page.getByTestId("chat-tab-strip")).toHaveCount(0);
    await expect(header.getByRole("button", { name: "New tab" })).toHaveCount(
      0,
    );
    await expect(header.getByRole("button", { name: "Close tab" })).toHaveCount(
      0,
    );
    await expect(
      header.getByRole("button", { name: "Download chat transcript" }),
    ).toBeDisabled();
    await expect(
      header.getByRole("button", { name: "Switch to dark mode" }),
    ).toBeVisible();
    await expect(
      header.getByRole("combobox", { name: "Model", exact: true }),
    ).toHaveCount(0);
    if (isMobile) {
      await expect(header.getByTestId("resolved-model-chip")).toBeHidden();
    } else {
      await expect(header.getByTestId("resolved-model-chip")).toBeVisible();
    }
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    await header.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();
    await expect(page.getByTestId("chat-tab-strip")).toHaveCount(0);

    const longTitlePrompt =
      "make the header state testable with a longer chat title please";
    await page.getByPlaceholder(/ask anything/i).fill(longTitlePrompt);
    await page.getByRole("button", { name: "Send" }).click();

    await expect(
      page.getByPlaceholder("Add a follow-up for the current run"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Queue follow-up" }),
    ).toBeDisabled();
    await expect(
      header.getByRole("button", { name: "Stop generating" }),
    ).toBeVisible();
    releaseFirstResponse?.();
    await expect(page.getByText("Shell response 1.")).toBeVisible();
    await expect(
      header.getByRole("button", { name: "Download chat transcript" }),
    ).toBeEnabled();
    await expect(page.getByTestId("active-chat-title")).toContainText(
      "make the header state testable",
    );
    await expect(page.getByTestId("chat-tab-strip")).toHaveCount(0);
    await expect(
      header.getByRole("button", { name: "Regenerate response" }),
    ).toHaveCount(0);

    const latestAssistant = page
      .getByTestId("assistant-message")
      .filter({ hasText: "Shell response 1." });
    await latestAssistant.hover();
    await latestAssistant
      .getByRole("button", { name: "Regenerate response" })
      .click();
    await expect(page.getByText("Shell response 2.")).toBeVisible();
    expect(calls).toBe(2);
    expect(chatBodies[1]!.replaceMessageId).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
  });

  test("shows jump to latest only outside the stick zone while a turn runs", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("mobile"),
      "desktop coverage exercises the shared scroll behavior",
    );

    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const longMessages = Array.from({ length: 18 }, (_, index) => [
      userMessage({
        id: `user-scroll-${index}`,
        content: `Question ${index + 1}: ${"context ".repeat(18)}`,
      }),
      assistantMessage({
        id: `assistant-scroll-${index}`,
        content: `Answer ${index + 1}: ${"detail ".repeat(24)}`,
      }),
    ]).flat();
    await installMockComparativeApi(page, {
      artifacts: [],
      threads: [
        {
          id: "thread-scroll",
          title: "Long conversation",
          defaultModelId: "sonnet-4-6",
          previewSummary: null,
          previewSummaryUpdatedAt: null,
          titleSource: "generated",
          createdAt: "2026-06-14T20:00:00.000Z",
          updatedAt: "2026-06-14T20:00:00.000Z",
        },
      ],
      threadMessages: { "thread-scroll": longMessages },
      onChat: async (_body, route) => {
        await responseGate;
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-scroll",
            userMessageId: "44444444-4444-4444-8444-444444444444",
            modelId: "sonnet-4-6",
          },
          { type: "text-delta", delta: "Newest answer." },
          {
            type: "persisted",
            assistantMessageId: "assistant-scroll-new",
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await gotoE2EChat(page);
    await page
      .getByRole("button", { name: "Long conversation", exact: true })
      .click();
    const scrollRegion = page.getByTestId("chat-scroll-region");
    await expect
      .poll(() =>
        scrollRegion.evaluate(
          (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
        ),
      )
      .toBeLessThan(100);

    await scrollRegion.evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll"));
    });
    await expect(
      page.getByRole("button", { name: "Jump to latest" }),
    ).toHaveCount(0);

    await page.getByPlaceholder(/ask anything/i).fill("Give me one more answer");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByPlaceholder("Add a follow-up for the current run"),
    ).toBeVisible();

    await scrollRegion.evaluate((node) => {
      node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 60);
      node.dispatchEvent(new Event("scroll"));
    });
    await expect(
      page.getByRole("button", { name: "Jump to latest" }),
    ).toHaveCount(0);

    await scrollRegion.evaluate((node) => {
      node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 140);
      node.dispatchEvent(new Event("scroll"));
    });
    const jumpButton = page.getByRole("button", { name: "Jump to latest" });
    await expect(jumpButton).toBeVisible();
    await expect(page.getByTestId("jump-to-latest-status")).toHaveText(
      "New content below",
    );

    await jumpButton.click();
    await expect
      .poll(() =>
        scrollRegion.evaluate(
          (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
        ),
      )
      .toBeLessThan(100);
    await expect(jumpButton).toHaveCount(0);

    releaseResponse?.();
    await expect(page.getByText("Newest answer.")).toBeVisible();
  });

  test("does not create page-level horizontal overflow", async ({ page }) => {
    await installMockComparativeApi(page);
    await gotoE2EChat(page);

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("mobile drawer opens, closes, and creates a fresh chat", async ({
    page,
  }, testInfo) => {
    test.skip(
      !testInfo.project.name.includes("mobile"),
      "mobile-only drawer behavior",
    );

    await installMockComparativeApi(page);
    await gotoE2EChat(page);

    const sidebar = page.locator('aside[aria-label="Primary"]');
    const openMenu = page.getByRole("button", { name: "Open menu" }).first();

    await expect(sidebar).not.toBeInViewport();
    await swipe(page, { x: 4, y: 260 }, { x: 132, y: 264 });
    await expect(sidebar).toBeInViewport();
    await expect
      .poll(async () => Math.round((await sidebar.boundingBox())?.x ?? -1))
      .toBe(0);

    await swipe(page, { x: 230, y: 28 }, { x: 90, y: 32 });
    await expect(sidebar).not.toBeInViewport();

    await openMenu.click();
    await expect(sidebar).toBeInViewport();

    const backdrop = page.getByTestId("sidebar-backdrop");
    await expect(backdrop).toBeVisible();
    const backdropBox = await backdrop.boundingBox();
    expect(backdropBox).toBeTruthy();
    await backdrop.click({
      position: { x: (backdropBox?.width ?? 390) - 8, y: 80 },
    });
    await expect(sidebar).not.toBeInViewport();

    await openMenu.click();
    await expect(sidebar).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(sidebar).not.toBeInViewport();

    await openMenu.click();
    await expect(sidebar).toBeInViewport();
    await page.getByRole("button", { name: "Close menu" }).click();
    await expect(sidebar).not.toBeInViewport();

    await openMenu.click();
    await expect(sidebar).toBeInViewport();
    await sidebar.getByRole("button", { name: "Account menu" }).click();
    await sidebar.getByRole("menuitem", { name: "Settings" }).click();
    await expect(sidebar).toBeInViewport();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "Close settings" }).click();

    await expect(sidebar).toBeInViewport();
    await sidebar.getByRole("button", { name: "New chat" }).click();
    await expect(sidebar).not.toBeInViewport();
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();
    await expect(page.getByTestId("active-chat-title")).toContainText(
      "New chat",
    );
    await expect(page.getByTestId("chat-tab-strip")).toHaveCount(0);
    await expect(
      page.locator("header").getByRole("button", { name: "New tab" }),
    ).toHaveCount(0);
  });

  test("does not render internal chat tabs on mobile", async ({
    page,
  }, testInfo) => {
    test.skip(
      !testInfo.project.name.includes("mobile"),
      "mobile-only shell behavior",
    );

    await installMockComparativeApi(page);
    await gotoE2EChat(page);

    const header = page.locator("header").first();
    await expect(
      header.getByRole("button", { name: "Open menu" }),
    ).toBeVisible();
    await expect(header.getByRole("button", { name: "New tab" })).toHaveCount(
      0,
    );
    await expect(header.getByRole("button", { name: "Close tab" })).toHaveCount(
      0,
    );
    await expect(page.getByTestId("chat-tab-strip")).toHaveCount(0);

    const pageOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(pageOverflow).toBeLessThanOrEqual(1);
  });

  test("keeps the mobile alpha badge in flow and compact controls tappable", async ({
    page,
  }, testInfo) => {
    test.skip(
      !testInfo.project.name.includes("mobile"),
      "mobile-only responsive behavior",
    );

    await page.addInitScript(() => {
      window.localStorage.setItem("ai-workspace-density", "compact");
    });
    await page.setViewportSize({ width: 320, height: 760 });
    await installMockComparativeApi(page);
    await gotoE2EChat(page);

    for (const width of [320, 480]) {
      await page.setViewportSize({ width, height: 760 });
      const header = page.locator("header").first();
      const badge = header.locator('[data-alpha-badge="inline"]');
      await expect(badge).toBeVisible();
      await expect(page.locator('[data-alpha-badge="global"]')).toBeHidden();
      if (width < 400) {
        await expect(page.getByTestId("resolved-model-chip")).toBeHidden();
      } else {
        await expect(page.getByTestId("resolved-model-chip")).toBeVisible();
      }
      const title = page.getByTestId("active-chat-title");
      await expect(title).toContainText("New chat");
      expect(
        await title.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);

      const badgeBox = await badge.boundingBox();
      const headerBox = await header.boundingBox();
      expect(badgeBox).toBeTruthy();
      expect(headerBox).toBeTruthy();
      expect(badgeBox!.x).toBeGreaterThanOrEqual(headerBox!.x);
      expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(
        headerBox!.x + headerBox!.width,
      );

      for (const control of await header.locator("button:visible").all()) {
        const controlBox = await control.boundingBox();
        expect(controlBox).toBeTruthy();
        expect(boxesOverlap(badgeBox!, controlBox!)).toBe(false);
      }
    }

    await expect(page.locator("html")).toHaveClass(/density-compact/);
    await swipe(page, { x: 4, y: 260 }, { x: 132, y: 264 });
    const sidebar = page.locator('aside[aria-label="Primary"]');
    await expect(sidebar).toBeInViewport();

    for (const button of await sidebar.locator("button:visible").all()) {
      const box = await button.boundingBox();
      expect(box).toBeTruthy();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    for (const name of ["Attach files", "Send"]) {
      const box = await page.getByRole("button", { name }).boundingBox();
      expect(box).toBeTruthy();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
});

function boxesOverlap(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
) {
  return !(
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}
