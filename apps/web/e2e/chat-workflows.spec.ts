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
  test("downloads the active chat as markdown", async ({ page }) => {
    await installMockComparativeApi(page, {
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-export",
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
          { type: "done" },
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
    expect(download.suggestedFilename()).toMatch(/please-make-this-exportable/i);
    expect(download.suggestedFilename()).toMatch(/\.md$/);

    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const transcript = await readFile(downloadPath!, "utf8");
    expect(transcript).toContain("# Please make this exportable.");
    expect(transcript).toContain("Please make this exportable.");
    expect(transcript).toContain(
      "Exportable answer with enough detail for a transcript and artifact.",
    );
    expect(transcript).toContain("- Thread ID: thread-export");
    expect(transcript).toContain("### Artifacts");
    expect(transcript).toContain("demo-artifact.html (html, 1.3 KB)");
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
          { type: "done" },
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
          { type: "done" },
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
    await expect(page.getByText("Talk to your work.")).toBeVisible();
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

    await page.reload();
    await expect(page.getByTestId("chat-tab-strip")).toHaveCount(0);
    await expect(page.getByText("Talk to your work.")).toBeVisible();

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
          { type: "done" },
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
});
