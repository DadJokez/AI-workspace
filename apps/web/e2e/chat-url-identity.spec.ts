import { expect, test } from "@playwright/test";
import {
  assistantMessage,
  installMockComparativeApi,
  now,
  userMessage,
} from "./helpers/mock-comparative";
import { gotoE2EChat, openPrimarySidebar } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked URL identity tests run only against the local e2e harness",
);

const threadA = {
  id: "thread-url-alpha",
  title: "Alpha URL thread",
  defaultModelId: "sonnet-4-6",
  summary: null,
  summaryUpdatedAt: null,
  previewSummary: null,
  previewSummaryUpdatedAt: null,
  titleSource: "generated",
  createdAt: now,
  updatedAt: now,
};

const threadAMessages = [
  userMessage({ id: "user-url-alpha", content: "alpha question" }),
  assistantMessage({ id: "assistant-url-alpha", content: "Alpha answer." }),
];

test.describe("URL identifies the visible conversation (#664)", () => {
  test("deep link restores the thread and New chat clears the URL", async ({
    page,
  }) => {
    await installMockComparativeApi(page, {
      threads: [threadA],
      threadMessages: { [threadA.id]: threadAMessages },
    });

    await page.goto(`/e2e/chat?threadId=${threadA.id}`);
    await expect(page.getByText("Alpha answer.")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`threadId=${threadA.id}`));

    await page.keyboard.press("Control+N");
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();
    await expect(page).toHaveURL(/\/e2e\/chat$/);
  });

  test("opening a thread from the sidebar puts its id in the URL", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page, {
      threads: [threadA],
      threadMessages: { [threadA.id]: threadAMessages },
    });
    await gotoE2EChat(page);

    const sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar.getByRole("button", { name: "Alpha URL thread" }).click();
    await expect(page.getByText("Alpha answer.")).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/e2e/chat\\?threadId=${threadA.id}$`),
    );
  });

  test("a thread created by the SSE stream lands in the URL", async ({
    page,
  }) => {
    // The default mocked /api/chat stream reports threadId "thread-generated".
    await installMockComparativeApi(page);
    await gotoE2EChat(page);

    await page.getByPlaceholder(/ask anything/i).fill("Start a conversation");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Done.")).toBeVisible();
    await expect(page).toHaveURL(/\/e2e\/chat\?threadId=thread-generated$/);
  });

  test("a deep link to a missing thread does not stick in the URL", async ({
    page,
  }) => {
    await installMockComparativeApi(page, { threads: [] });
    await page.route("**/api/threads/thread-missing/messages", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "thread_not_found" }),
      }),
    );

    await page.goto("/e2e/chat?threadId=thread-missing");
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();
    await expect(page).toHaveURL(/\/e2e\/chat$/);
  });
});
