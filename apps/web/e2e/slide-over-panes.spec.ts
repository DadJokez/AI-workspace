import { expect, test, type Locator } from "@playwright/test";
import {
  assistantMessage,
  installMockComparativeApi,
  now,
  userMessage,
} from "./helpers/mock-comparative";
import {
  gotoE2EChat,
  openNavItem,
  openPrimarySidebar,
} from "./helpers/navigation";
import { swipe } from "./helpers/swipe";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked slide-over tests run only against the local e2e harness",
);

const threadId = "thread-slide-over-preservation";

test.describe("right slide-over panes", () => {
  test("keep chat mounted and scrolled while panes open, resize, and replace one another", async ({
    page,
  }, testInfo) => {
    const isMobile = testInfo.project.name.includes("mobile");
    const messages = Array.from({ length: 36 }, (_, index) =>
      index % 2 === 0
        ? userMessage({
            id: `user-${index}`,
            content: `User note ${index + 1}`,
          })
        : assistantMessage({
            id: `assistant-${index}`,
            content: `Assistant answer ${index + 1}`,
          }),
    );

    await installMockComparativeApi(page, {
      threads: [
        {
          id: threadId,
          title: "Slide-over preservation",
          defaultModelId: "sonnet-4-6",
          summary: null,
          summaryUpdatedAt: null,
          previewSummary: null,
          previewSummaryUpdatedAt: null,
          titleSource: "generated",
          createdAt: now,
          updatedAt: now,
        },
      ],
      threadMessages: { [threadId]: messages },
      notifications: [],
    });

    await gotoE2EChat(page);
    const sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar
      .getByRole("button", { name: "Slide-over preservation" })
      .click();

    const scrollRegion = page.getByTestId("chat-scroll-region");
    await expect(page.getByText("Assistant answer 36")).toBeVisible();
    const messageRows = page.getByTestId("chat-message-row");
    await expect(messageRows).toHaveCount(36);
    await expect(messageRows.first()).toHaveCSS("content-visibility", "auto");
    await scrollRegion.evaluate((element) => {
      element.scrollTop = Math.floor(
        (element.scrollHeight - element.clientHeight) / 2,
      );
    });
    const scrollBefore = await scrollRegion.evaluate(
      (element) => element.scrollTop,
    );
    expect(scrollBefore).toBeGreaterThan(0);

    await openNavItem(page, "Artifacts", isMobile);
    const artifactsPane = page.getByTestId("artifacts-pane");
    await expect(artifactsPane).toBeVisible();
    await expect(scrollRegion).toBeAttached();
    await expectScrollPosition(scrollRegion, scrollBefore);

    if (isMobile) {
      await artifactsPane.evaluate((pane) => {
        const scroller = document.createElement("div");
        scroller.dataset.testid = "horizontal-swipe-guard";
        Object.assign(scroller.style, {
          position: "absolute",
          top: "5rem",
          right: "1rem",
          zIndex: "80",
          width: "12rem",
          height: "2.75rem",
          overflowX: "auto",
          background: "var(--surface)",
        });
        const content = document.createElement("div");
        content.style.width = "40rem";
        content.style.height = "100%";
        scroller.append(content);
        pane.append(scroller);
      });
      const scrollerBox = await page
        .getByTestId("horizontal-swipe-guard")
        .boundingBox();
      expect(scrollerBox).toBeTruthy();
      await swipe(
        page,
        { x: scrollerBox!.x + 160, y: scrollerBox!.y + 20 },
        { x: scrollerBox!.x + 40, y: scrollerBox!.y + 20 },
      );
      await expect(artifactsPane).toBeVisible();

      await page.getByTestId("horizontal-swipe-guard").evaluate((node) => {
        node.remove();
      });
      const paneBox = await artifactsPane.boundingBox();
      expect(paneBox).toBeTruthy();
      await swipe(
        page,
        { x: paneBox!.x + paneBox!.width - 80, y: paneBox!.y + 24 },
        { x: paneBox!.x + paneBox!.width - 200, y: paneBox!.y + 28 },
      );
      await expect(artifactsPane).toHaveCount(0);
      await openNavItem(page, "Artifacts", true);
      await expect(page.getByTestId("artifacts-pane")).toBeVisible();
    } else {
      const widthBefore = await paneWidth(artifactsPane);
      await page.getByTestId("artifacts-pane-resizer").press("Shift+ArrowLeft");
      const resizedWidth = await paneWidth(artifactsPane);
      expect(resizedWidth).toBeGreaterThan(widthBefore + 60);

      await page.getByRole("button", { name: "Close workspace" }).click();
      await openNavItem(page, "Artifacts", false);
      await expect
        .poll(() => paneWidth(page.getByTestId("artifacts-pane")))
        .toBe(resizedWidth);
    }

    await page.getByRole("button", { name: "Demo Artifact" }).click();
    await expect(
      page.getByRole("complementary", { name: "Artifact preview" }),
    ).toBeVisible();
    await expect(page.getByTestId("artifacts-pane")).toHaveCount(0);
    await expectScrollPosition(scrollRegion, scrollBefore);
    await page.getByRole("button", { name: "Close preview" }).click();

    await page.getByTestId("notification-bell").click();
    await expect(page.getByTestId("notifications-pane")).toBeVisible();
    await expectScrollPosition(scrollRegion, scrollBefore);
    await page.getByRole("button", { name: "Close notifications" }).click();

    await expect(page.getByTestId("notifications-pane")).toHaveCount(0);
    await expectScrollPosition(scrollRegion, scrollBefore);
  });
});

async function paneWidth(pane: Locator) {
  return pane.evaluate((element) =>
    Math.round(element.getBoundingClientRect().width),
  );
}

async function expectScrollPosition(region: Locator, expected: number) {
  await expect
    .poll(() => region.evaluate((element) => element.scrollTop))
    .toBe(expected);
}
