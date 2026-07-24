import { MAX_TOKENS_TRUNCATION_NOTICE } from "@ai-workspace/agent";
import { expect, test } from "@playwright/test";
import {
  assistantMessage,
  defaultArtifactDetail,
  defaultArtifactSummary,
  fulfillSse,
  installMockComparativeApi,
  userMessage,
} from "./helpers/mock-comparative";
import { gotoE2EChat, openPrimarySidebar } from "./helpers/navigation";
import { MAX_RUNTIME_IMAGE_BYTES } from "../lib/attachments";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked chat feature tests run only against the local e2e harness",
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
    createdAt: "2026-05-01T12:00:00.000Z",
    updatedAt: "2026-05-01T12:00:00.000Z",
  };
}

test.describe("chat files and artifacts", () => {
  test("sends image uploads through the chat request payload", async ({
    page,
  }) => {
    let capturedBody: Record<string, unknown> | undefined;

    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (body, route) => {
        capturedBody = body;
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-upload",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: "I reviewed the attached screenshot.",
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-upload",
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();

    // #398: same pre-hydration race #372/#377 fixed in authenticated-smoke —
    // setInputFiles before React wires the input's handler silently drops the
    // upload. The input stays disabled until hydration, so enabled = ready.
    const fileInput = page.getByTestId("chat-file-input");
    await expect(fileInput).toBeEnabled({ timeout: 15_000 });
    await fileInput.setInputFiles({
      name: "screenshot.png",
      mimeType: "image/png",
      buffer: Buffer.from("fake-png-bytes"),
    });
    await expect(page.getByText("screenshot.png")).toBeVisible();

    await page
      .getByPlaceholder(/ask anything/i)
      .fill("What can you tell me about this screenshot?");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(
      page.getByText("I reviewed the attached screenshot."),
    ).toBeVisible();
    expect(capturedBody?.attachmentCount).toBe(1);
    const attachments = capturedBody?.attachments as
      | Array<{
          name?: unknown;
          mimeType?: unknown;
          sizeBytes?: unknown;
          dataBase64?: unknown;
        }>
      | undefined;
    expect(Array.isArray(attachments)).toBe(true);
    expect(attachments).toHaveLength(1);
    expect(attachments?.[0]).toMatchObject({
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 14,
    });
    expect(typeof attachments?.[0]?.dataBase64).toBe("string");
    expect(String(attachments?.[0]?.dataBase64 ?? "").length).toBeGreaterThan(
      0,
    );
  });

  test("#650 keeps uploads stable, clears them on New chat, and ignores exact duplicates", async ({
    page,
  }, testInfo) => {
    let capturedBody: Record<string, unknown> | undefined;
    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (body, route) => {
        capturedBody = body;
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-deduped-upload",
            modelId: "sonnet-4-6",
          },
          { type: "text-delta", delta: "CSV received once." },
          {
            type: "persisted",
            assistantMessageId: "assistant-deduped-upload",
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });
    await page.goto("/e2e/chat");

    const file = {
      name: "codex-browser-canary.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("customer,revenue\nAcme,42"),
    };
    const fileInput = page.getByTestId("chat-file-input");
    const composer = page.getByPlaceholder(/ask anything/i);
    await expect(fileInput).toBeEnabled({ timeout: 15_000 });
    await composer.fill("Analyze this CSV later.");
    await fileInput.setInputFiles(file);
    await expect(
      page.getByRole("button", {
        name: "Remove codex-browser-canary.csv",
      }),
    ).toBeVisible();

    const sidebar = page.locator('aside[aria-label="Primary"]');
    if (testInfo.project.name.includes("mobile")) {
      await page.getByRole("button", { name: "Open menu" }).first().click();
      await expect(sidebar).toBeInViewport();
    }
    await sidebar.getByRole("button", { name: "New chat" }).click();
    await expect(
      page.getByRole("button", {
        name: "Remove codex-browser-canary.csv",
      }),
    ).toHaveCount(0);
    await expect(composer).toHaveValue("");

    await fileInput.setInputFiles(file);
    await fileInput.setInputFiles(file);
    await expect(
      page.getByRole("button", {
        name: "Remove codex-browser-canary.csv",
      }),
    ).toHaveCount(1);
    await page.waitForTimeout(300);
    await expect(
      page.getByRole("button", {
        name: "Remove codex-browser-canary.csv",
      }),
    ).toHaveCount(1);

    await composer.fill("Read the CSV.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("CSV received once.")).toBeVisible();
    expect(capturedBody?.attachmentCount).toBe(1);
    expect(capturedBody?.attachments).toEqual([
      expect.objectContaining({ name: "codex-browser-canary.csv" }),
    ]);
  });

  test("rejects images above the Bedrock native-image limit before send", async ({
    page,
  }) => {
    await installMockComparativeApi(page, { artifacts: [] });
    await page.goto("/e2e/chat");

    const fileInput = page.getByTestId("chat-file-input");
    await expect(fileInput).toBeEnabled({ timeout: 15_000 });
    await fileInput.setInputFiles({
      name: "oversized.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(MAX_RUNTIME_IMAGE_BYTES + 1),
    });

    await expect(
      page.getByText(/limit is 3\.75 MB for image analysis/i),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove oversized.png" }),
    ).toHaveCount(0);
  });

  test("sends a representative business-file bundle through chat", async ({
    page,
  }) => {
    let capturedBody: Record<string, unknown> | undefined;
    const files = [
      { name: "brief.pdf", mimeType: "application/pdf" },
      {
        name: "requirements.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      {
        name: "pipeline.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      {
        name: "deck.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      },
      { name: "data.csv", mimeType: "text/csv" },
    ];

    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (body, route) => {
        capturedBody = body;
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-business-files",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: "I received the business file bundle.",
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-business-files",
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();

    // #398: hydration barrier — see comment on the first upload above.
    const bundleInput = page.getByTestId("chat-file-input");
    await expect(bundleInput).toBeEnabled({ timeout: 15_000 });
    await bundleInput.setInputFiles(
      files.map((file) => ({
        ...file,
        buffer: Buffer.from(`fake content for ${file.name}`),
      })),
    );
    for (const file of files) {
      await expect(page.getByText(file.name)).toBeVisible();
    }

    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Summarize these business files.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(
      page.getByText("I received the business file bundle."),
    ).toBeVisible();
    expect(capturedBody?.attachmentCount).toBe(files.length);
    const attachments = capturedBody?.attachments as
      | Array<{ name?: unknown; mimeType?: unknown; dataBase64?: unknown }>
      | undefined;
    expect(attachments?.map((attachment) => attachment.name)).toEqual(
      files.map((file) => file.name),
    );
    expect(attachments?.every((attachment) => attachment.dataBase64)).toBe(
      true,
    );
  });

  test("keeps one uploaded file active through follow-up, refresh, and another follow-up (#576)", async ({
    page,
    isMobile,
  }) => {
    const threadId = "thread-durable-resource";
    const chatBodies: Array<Record<string, unknown>> = [];
    const threadMessages: Record<string, unknown[]> = { [threadId]: [] };
    await installMockComparativeApi(page, {
      artifacts: [],
      threads: [threadSummary(threadId, "Durable resource analysis")],
      threadMessages,
      onChat: async (body, route) => {
        chatBodies.push(body);
        const ordinal = chatBodies.length;
        const prompt = String(body.message ?? "");
        const answer =
          ordinal === 1
            ? "I received the report."
            : ordinal === 2
              ? "The middle fact is still available."
              : "The end fact is still available after refresh.";
        threadMessages[threadId] = [
          ...(threadMessages[threadId] ?? []),
          userMessage({
            id: `resource-user-${ordinal}`,
            content: prompt,
          }),
          assistantMessage({
            id: `resource-assistant-${ordinal}`,
            content: answer,
          }),
        ];
        await fulfillSse(route, [
          { type: "meta", threadId, modelId: "sonnet-4-6" },
          { type: "text-delta", delta: answer },
          {
            type: "persisted",
            assistantMessageId: `resource-assistant-${ordinal}`,
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await page.goto(`/e2e/chat?threadId=${threadId}`);
    const fileInput = page.getByTestId("chat-file-input");
    await expect(fileInput).toBeEnabled({ timeout: 15_000 });
    await fileInput.setInputFiles({
      name: "durable-report.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "position,fact\nbeginning,alpha\nmiddle,bravo\nend,charlie",
      ),
    });
    const composer = page.getByPlaceholder(/ask anything/i);
    await composer.fill("Analyze durable-report.csv.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("I received the report.")).toBeVisible();

    await composer.fill("What is the middle fact?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText("The middle fact is still available."),
    ).toBeVisible();

    await page.reload();
    const sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar
      .getByRole("button", { name: "Durable resource analysis" })
      .click();
    await expect(
      page.getByText("The middle fact is still available."),
    ).toBeVisible();
    await composer.fill("Now give me the end fact.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText("The end fact is still available after refresh."),
    ).toBeVisible();

    expect(chatBodies).toHaveLength(3);
    expect(chatBodies[0]).toMatchObject({
      attachmentCount: 1,
    });
    expect(chatBodies[0]?.threadId).toBeUndefined();
    expect(chatBodies[1]).toMatchObject({
      threadId,
      attachmentCount: 0,
    });
    expect(chatBodies[2]).toMatchObject({
      threadId,
      attachmentCount: 0,
    });
    expect(chatBodies[1]?.attachments).toBeUndefined();
    expect(chatBodies[2]?.attachments).toBeUndefined();
  });

  test("collapses generated documents and opens the artifact preview in-tab", async ({
    page,
    isMobile,
  }) => {
    const repeatedRows = Array.from({ length: 240 }, (_, index) => {
      return `<li>Demo row ${index + 1}</li>`;
    }).join("");
    const htmlDoc = [
      "<!doctype html>",
      "<html>",
      "<head><title>Demo Artifact</title></head>",
      `<body><h1>Demo Artifact</h1><ul>${repeatedRows}</ul></body>`,
      "</html>",
    ].join("\n");

    await installMockComparativeApi(page, {
      artifacts: [defaultArtifactSummary],
      artifactDetails: {
        [defaultArtifactSummary.id]: {
          ...defaultArtifactDetail,
          content: htmlDoc,
        },
      },
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-generated",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: [
              "Here is the generated app:",
              "",
              '```html filename="demo-artifact.html"',
              htmlDoc,
              "```",
              "",
              "I stored it in your workspace.",
            ].join("\n"),
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-generated",
            artifacts: [defaultArtifactSummary],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();

    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Build a tiny HTML app and save it.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Document content collapsed")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /demo-artifact\.html/i }),
    ).toBeVisible();

    await page.getByText("Show code").click();
    const codePreview = page.getByTestId("artifact-code-preview-scroll");
    await expect(codePreview).toBeVisible();
    await expect(codePreview).toContainText("Demo row 240");
    const codeMetrics = await codePreview.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      text: element.textContent ?? "",
    }));
    expect(codeMetrics.scrollHeight).toBeGreaterThan(codeMetrics.clientHeight);
    expect(codeMetrics.text).not.toContain("\n...");

    const chatPane = page.getByTestId("chat-workspace-pane");
    const chatWidthBefore = await chatPane.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    const previewBefore = page.context().pages().length;
    await page.getByRole("button", { name: /demo-artifact\.html/i }).click();
    const previewPane = page.getByRole("complementary", {
      name: "Artifact preview",
    });
    await expect(
      previewPane,
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Demo Artifact" }),
    ).toBeVisible();
    expect(page.context().pages()).toHaveLength(previewBefore);

    if (!isMobile) {
      const chatWidthAfter = await chatPane.evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      expect(chatWidthAfter).toBeLessThan(chatWidthBefore - 100);

      const resizer = page.getByTestId("artifact-preview-resizer");
      await expect(resizer).toBeVisible();
      const previewWidthBefore = await previewPane.evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      const box = await resizer.boundingBox();
      expect(box).toBeTruthy();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + 100);
      await page.mouse.down();
      await page.mouse.move(box!.x - 120, box!.y + 100);
      await page.mouse.up();
      const previewWidthAfter = await previewPane.evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      expect(previewWidthAfter).toBeGreaterThan(previewWidthBefore + 60);
    }

    await page.getByRole("button", { name: "Close preview" }).click();
    if (isMobile) {
      await page.getByRole("button", { name: "Open menu" }).click();
    }
    await page.getByRole("button", { name: "Artifacts" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Artifacts" }),
    ).toBeVisible();
    await expect(
      page.getByTestId("artifacts-pane").getByText(/demo-artifact\.html/),
    ).toBeVisible();
  });

  test("shows the truncation notice as visible prose when cut off mid-artifact", async ({
    page,
  }) => {
    // #320: the model is cut off mid-artifact, so its text ends with an open
    // ```html fence. runAgentLoop closes that dangling fence and appends the
    // truncation notice. The notice must render as a visible callout below the
    // collapsed artifact — not get parsed into (and hidden behind) the code
    // fence, which was the honesty failure this PR targets.
    const rows = Array.from(
      { length: 240 },
      (_, index) => `<li>Row ${index + 1}</li>`,
    ).join("");
    const truncatedHtml = [
      "<!doctype html>",
      "<html>",
      "<head><title>Cut Off App</title></head>",
      `<body><h1>Cut Off App</h1><ul>${rows}`, // cut off mid-body: no </ul></body></html>
    ].join("\n");
    // What runAgentLoop emits: model text + loop-injected fence close + notice.
    const emitted = `${[
      "Here is the app:",
      "",
      "```html",
      truncatedHtml,
      "```", // injected by the loop to close the dangling fence
    ].join("\n")}${MAX_TOKENS_TRUNCATION_NOTICE}`;

    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          { type: "meta", threadId: "thread-truncated", modelId: "sonnet-4-6" },
          { type: "text-delta", delta: emitted },
          {
            type: "persisted",
            assistantMessageId: "assistant-truncated",
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();

    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Build a big HTML app.");
    await page.getByRole("button", { name: "Send" }).click();

    // The artifact collapses (its code is hidden behind "Show code")…
    await expect(page.getByText("Document content collapsed")).toBeVisible();
    // …yet the truncation notice is still visible as prose, proving it landed
    // outside the fence rather than being swallowed into the collapsed code.
    await expect(page.getByText(/output length limit/i)).toBeVisible();
  });

  test("#256 keeps an open artifact preview on the latest revision", async ({
    page,
    isMobile,
  }) => {
    const initialHtml = [
      "<!doctype html>",
      "<html>",
      "<head><title>Demo Artifact</title></head>",
      "<body><h1>Demo Artifact</h1><p>Original version.</p></body>",
      "</html>",
    ].join("\n");
    const revisedHtml = [
      "<!doctype html>",
      "<html>",
      "<head><title>Demo Artifact</title></head>",
      "<body><h1>Revised Demo Artifact</h1><p>Updated version.</p></body>",
      "</html>",
    ].join("\n");
    const revisedArtifactSummary = {
      ...defaultArtifactSummary,
      id: "artifact-demo-html-v2",
      filename: "demo-artifact.html",
      chatMessageId: "assistant-revised",
      runId: "run-revised",
      versionNumber: 2,
      supersedesArtifactId: defaultArtifactSummary.id,
      sizeBytes: revisedHtml.length,
      createdAt: "2026-06-19T12:00:00.000Z",
      previewUrl: "/api/workspace/artifacts/artifact-demo-html-v2/preview",
      downloadUrl: "/api/workspace/artifacts/artifact-demo-html-v2/download",
    };
    let chatCount = 0;

    await installMockComparativeApi(page, {
      artifacts: [revisedArtifactSummary, defaultArtifactSummary],
      artifactDetails: {
        [defaultArtifactSummary.id]: {
          ...defaultArtifactDetail,
          content: initialHtml,
        },
        [revisedArtifactSummary.id]: {
          ...revisedArtifactSummary,
          content: revisedHtml,
        },
      },
      onChat: async (body, route) => {
        chatCount += 1;
        if (chatCount === 1) {
          await fulfillSse(route, [
            {
              type: "meta",
              threadId: "thread-generated",
              modelId: "sonnet-4-6",
            },
            {
              type: "text-delta",
              delta: [
                "Here is the generated app:",
                "",
                '```html filename="demo-artifact.html"',
                initialHtml,
                "```",
              ].join("\n"),
            },
            {
              type: "persisted",
              assistantMessageId: "assistant-generated",
              artifacts: [defaultArtifactSummary],
              recommendations: [],
            },
            { type: "done", stopReason: "completed" },
          ]);
          return;
        }

        expect(body.threadId).toBe("thread-generated");
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-generated",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: [
              "Updated the existing artifact:",
              "",
              '```html filename="updated.html"',
              revisedHtml,
              "```",
            ].join("\n"),
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-revised",
            artifacts: [revisedArtifactSummary],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();

    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Build a tiny HTML app and save it.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(
      page.getByRole("button", { name: /demo-artifact\.html/i }),
    ).toBeVisible();
    await page.getByRole("button", { name: /demo-artifact\.html/i }).click();
    const previewPane = page.getByRole("complementary", {
      name: "Artifact preview",
    });
    await expect(previewPane).toBeVisible();
    await expect(
      previewPane.frameLocator("iframe").getByRole("heading", {
        name: "Demo Artifact",
      }),
    ).toBeVisible();
    if (isMobile) {
      await page.getByRole("button", { name: "Close preview" }).click();
    }

    await page
      .getByPlaceholder(/ask anything/i)
      .fill("update the prior made html file with a revised headline");
    await page.getByRole("button", { name: "Send" }).click();

    const revisedArtifactPill = page.locator(
      '[data-testid="artifact-pill"][data-artifact-id="artifact-demo-html-v2"]',
    );
    await expect(revisedArtifactPill).toBeVisible();
    if (isMobile) {
      await revisedArtifactPill.click();
    }
    const revisedPreviewPane = page.getByRole("complementary", {
      name: "Artifact preview",
    });
    await expect(revisedPreviewPane).toContainText("demo-artifact.html");
    await expect(revisedPreviewPane).not.toContainText("demo-artifact.html · v2");
    await expect(
      revisedPreviewPane.frameLocator("iframe").getByRole("heading", {
        name: "Revised Demo Artifact",
      }),
    ).toBeVisible();
  });

  test("#284 revises an artifact after reopening an old chat", async ({
    page,
    isMobile,
  }) => {
    const threadId = "thread-old-artifact";
    const initialHtml = [
      "<!doctype html>",
      "<html>",
      "<head><title>Old Project</title></head>",
      "<body><h1>Old Project</h1><p>Original version.</p></body>",
      "</html>",
    ].join("\n");
    const revisedHtml = [
      "<!doctype html>",
      "<html>",
      "<head><title>Old Project</title></head>",
      "<body><h1>Old Project Revised</h1><p>Updated after reopening.</p></body>",
      "</html>",
    ].join("\n");
    const originalArtifact = {
      ...defaultArtifactSummary,
      id: "artifact-old-project-v1",
      title: "Old Project",
      filename: "old-project.html",
      threadId,
      chatMessageId: "assistant-old-project",
      runId: "run-old-project-v1",
      artifactGroupId: "old-project",
      sizeBytes: initialHtml.length,
      createdAt: "2026-05-01T12:00:00.000Z",
      previewUrl:
        "/api/workspace/artifacts/artifact-old-project-v1/preview",
      downloadUrl:
        "/api/workspace/artifacts/artifact-old-project-v1/download",
    };
    const revisedArtifact = {
      ...originalArtifact,
      id: "artifact-old-project-v2",
      chatMessageId: "assistant-old-project-revised",
      runId: "run-old-project-v2",
      versionNumber: 2,
      supersedesArtifactId: originalArtifact.id,
      sizeBytes: revisedHtml.length,
      createdAt: "2026-07-10T05:00:00.000Z",
      previewUrl:
        "/api/workspace/artifacts/artifact-old-project-v2/preview",
      downloadUrl:
        "/api/workspace/artifacts/artifact-old-project-v2/download",
    };

    await installMockComparativeApi(page, {
      threads: [threadSummary(threadId, "Build the old project")],
      threadMessages: {
        [threadId]: [
          userMessage({
            id: "user-old-project",
            content: "Build the old project as an HTML file.",
            createdAt: "2026-05-01T12:00:00.000Z",
          }),
          assistantMessage({
            id: "assistant-old-project",
            content: "I saved the original project.",
            artifacts: [originalArtifact],
            createdAt: "2026-05-01T12:01:00.000Z",
          }),
        ],
      },
      artifacts: [revisedArtifact, originalArtifact],
      artifactDetails: {
        [originalArtifact.id]: {
          ...originalArtifact,
          content: initialHtml,
        },
        [revisedArtifact.id]: {
          ...revisedArtifact,
          content: revisedHtml,
        },
      },
      onChat: async (body, route) => {
        expect(body.threadId).toBe(threadId);
        await fulfillSse(route, [
          { type: "meta", threadId, modelId: "sonnet-4-6" },
          {
            type: "text-delta",
            delta: [
              "Updated the existing artifact:",
              "",
              '```html filename="updated.html"',
              revisedHtml,
              "```",
            ].join("\n"),
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-old-project-revised",
            artifacts: [revisedArtifact],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await gotoE2EChat(page);
    const sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar
      .getByRole("button", { name: /build the old project/i })
      .click();

    await expect(
      page.locator(
        '[data-testid="artifact-pill"][data-artifact-id="artifact-old-project-v1"]',
      ),
    ).toBeVisible();
    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Update the prior HTML file with a revised headline.");
    await page.getByRole("button", { name: "Send" }).click();

    const revisedArtifactPill = page.locator(
      '[data-testid="artifact-pill"][data-artifact-id="artifact-old-project-v2"]',
    );
    await expect(revisedArtifactPill).toBeVisible();
    await revisedArtifactPill.click();
    const previewPane = page.getByRole("complementary", {
      name: "Artifact preview",
    });
    await expect(previewPane).toContainText("old-project.html");
    await expect(previewPane).not.toContainText("old-project.html · v2");
    await expect(
      previewPane.frameLocator("iframe").getByRole("heading", {
        name: "Old Project Revised",
      }),
    ).toBeVisible();
  });

  test("#242 collapses declared Markdown instead of showing raw source", async ({
    page,
  }) => {
    const markdownArtifact = {
      id: "artifact-markdown-formatting",
      title: "Markdown Formatting Reference",
      filename: "markdown-formatting-reference.md",
      kind: "markdown",
      mimeType: "text/markdown",
      sizeBytes: 740,
      source: "assistant-code-block",
      threadId: "thread-markdown-artifact",
      chatMessageId: "assistant-markdown-artifact",
      runId: "run-markdown-artifact",
      artifactGroupId: "markdown-formatting-reference",
      versionNumber: 1,
      supersedesArtifactId: null,
      versionSummary: "Initial artifact created from chat.",
      metadata: {
        extractedFrom: "assistant-declared-text-artifact",
        originalFilename: "markdown-formatting-reference.md",
      },
      createdAt: defaultArtifactSummary.createdAt,
      previewUrl: "/workspace/artifacts/artifact-markdown-formatting",
      downloadUrl:
        "/api/workspace/artifacts/artifact-markdown-formatting/download",
    };

    await installMockComparativeApi(page, {
      artifacts: [markdownArtifact],
      artifactDetails: {
        [markdownArtifact.id]: {
          ...markdownArtifact,
          content: [
            "# Markdown Formatting Reference",
            "",
            "- **Headings** (H1-H6)",
            "- **GitHub Alerts** — NOTE, TIP, IMPORTANT, WARNING, CAUTION",
          ].join("\n"),
        },
      },
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-markdown-artifact",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: [
              "Here's a comprehensive Markdown formatting reference:Written to `markdown-formatting-reference.md`.",
              "",
              "Here's what's covered:",
              "",
              "- **Headings** (H1-H6)",
              "- **Text emphasis** — bold, italic, bold+italic, strikethrough",
              "- **Tables** — basic, aligned, with in-cell formatting",
              "- **GitHub Alerts** — NOTE, TIP, IMPORTANT, WARNING, CAUTION",
            ].join("\n"),
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-markdown-artifact",
            artifacts: [markdownArtifact],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Make a markdown formatting reference.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Document content collapsed")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /markdown-formatting-reference\.md/i }),
    ).toBeVisible();
    await expect(page.getByText("Here's what's covered:")).toBeHidden();
    await expect(page.getByText(/GitHub Alerts/)).toBeHidden();
  });

  test("marks collapsed generated documents that were not saved as artifacts", async ({
    page,
  }) => {
    const htmlDoc = [
      "<!doctype html>",
      "<html>",
      "<head><title>Unsaved Demo</title></head>",
      `<body>${"<section>Demo</section>".repeat(40)}</body>`,
      "</html>",
    ].join("\n");

    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-unsaved-artifact",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: [
              "Here is the generated app:",
              "",
              '```html filename="unsaved-demo.html"',
              htmlDoc,
              "```",
            ].join("\n"),
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-unsaved-artifact",
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    await page.getByPlaceholder(/ask anything/i).fill("Build a demo app.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Document content collapsed")).toBeVisible();
    await expect(page.getByText("Not saved")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /unsaved-demo\.html/i }),
    ).toHaveCount(0);
  });
});
