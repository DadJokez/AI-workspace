import { expect, test } from "@playwright/test";
import { installMockComparativeApi } from "./helpers/mock-comparative";
import { gotoE2EChat, openPrimarySidebar } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked thread-history tests run only against the local e2e harness",
);

test("pins a chat in the flat newest-first history and persists after reload", async ({
  page,
  isMobile,
}) => {
  await installMockComparativeApi(page, {
    threads: [
      {
        id: "thread-oldest",
        title: "Oldest unpinned",
        pinned: false,
        defaultModelId: "sonnet-4-6",
        previewSummary: null,
        previewSummaryUpdatedAt: null,
        titleSource: "auto",
        createdAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z",
      },
      {
        id: "thread-newest",
        title: "Newest unpinned",
        pinned: false,
        defaultModelId: "sonnet-4-6",
        previewSummary: null,
        previewSummaryUpdatedAt: null,
        titleSource: "auto",
        createdAt: "2026-07-21T12:00:00.000Z",
        updatedAt: "2026-07-21T12:00:00.000Z",
      },
      {
        id: "thread-pinned",
        title: "Older pinned",
        pinned: true,
        defaultModelId: "sonnet-4-6",
        previewSummary: null,
        previewSummaryUpdatedAt: null,
        titleSource: "auto",
        createdAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:00:00.000Z",
      },
    ],
  });
  const threadRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/threads") {
      threadRequests.push(request.url());
    }
  });

  await gotoE2EChat(page);
  let sidebar = await openPrimarySidebar(page, isMobile);
  const history = sidebar.getByTestId("thread-history-list");
  const titles = () =>
    history
      .locator("[data-thread-id] > div > button[title]")
      .allTextContents();

  await expect.poll(titles).toEqual([
    "Older pinned",
    "Newest unpinned",
    "Oldest unpinned",
  ]);
  await expect(sidebar.getByText("Previous 7 days")).toHaveCount(0);
  expect(threadRequests.some((url) => url.includes("scope=mine"))).toBe(true);
  if (!isMobile) {
    await expect
      .poll(() =>
        history.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            flexGrow: style.flexGrow,
            maxHeight: style.maxHeight,
            overflowY: style.overflowY,
          };
        }),
      )
      .toEqual({ flexGrow: "1", maxHeight: "none", overflowY: "auto" });
  }

  const newestRow = history.locator('[data-thread-id="thread-newest"]');
  await newestRow.getByRole("button", { name: "Thread actions" }).click();
  await newestRow.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect.poll(titles).toEqual([
    "Newest unpinned",
    "Older pinned",
    "Oldest unpinned",
  ]);

  await page.reload();
  sidebar = await openPrimarySidebar(page, isMobile);
  const reloadedHistory = sidebar.getByTestId("thread-history-list");
  await expect
    .poll(() =>
      reloadedHistory
        .locator("[data-thread-id] > div > button[title]")
        .allTextContents(),
    )
    .toEqual(["Newest unpinned", "Older pinned", "Oldest unpinned"]);

  const reloadedNewest = reloadedHistory.locator(
    '[data-thread-id="thread-newest"]',
  );
  await reloadedNewest
    .getByRole("button", { name: "Thread actions" })
    .click();
  await expect(
    reloadedNewest.getByRole("menuitem", { name: "Unpin", exact: true }),
  ).toBeVisible();
});
