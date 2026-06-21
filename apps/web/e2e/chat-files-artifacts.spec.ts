import { expect, test } from "@playwright/test";
import {
  defaultArtifactDetail,
  defaultArtifactSummary,
  fulfillSse,
  installMockComparativeApi,
} from "./helpers/mock-comparative";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked chat feature tests run only against the local e2e harness",
);

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
          { type: "done" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByText("Talk to your work.")).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles({
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
          { type: "done" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByText("Talk to your work.")).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles(
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

  test("collapses generated documents and opens the artifact preview in-tab", async ({
    page,
    isMobile,
  }) => {
    const repeatedRows = Array.from({ length: 80 }, (_, index) => {
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
          { type: "done" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByText("Talk to your work.")).toBeVisible();

    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Build a tiny HTML app and save it.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Document content collapsed")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /demo-artifact\.html/i }),
    ).toBeVisible();

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
    await expect(page.getByText("demo-artifact.html")).toBeVisible();
  });

  test("keeps an open artifact preview on the latest revision", async ({
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
            { type: "done" },
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
          { type: "done" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByText("Talk to your work.")).toBeVisible();

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

  test("collapses declared markdown artifacts instead of showing raw markdown", async ({
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
          { type: "done" },
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
          { type: "done" },
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
