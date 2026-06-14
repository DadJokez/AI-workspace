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

    const previewBefore = page.context().pages().length;
    await page.getByRole("button", { name: /demo-artifact\.html/i }).click();
    await expect(
      page.getByRole("complementary", { name: "Artifact preview" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Demo Artifact" }),
    ).toBeVisible();
    expect(page.context().pages()).toHaveLength(previewBefore);

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
});
