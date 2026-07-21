import { expect, test, type Locator, type Page } from "@playwright/test";
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from "../lib/sidebar-layout";
import {
  installMockComparativeApi,
  now,
} from "./helpers/mock-comparative";
import { gotoE2EChat, openNavItem } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked sidebar tests run only against the local e2e harness",
);

const sidebarThread = {
  id: "thread-sidebar-rail",
  title: "Sidebar rail acceptance",
  defaultModelId: "sonnet-4-6",
  previewSummary: "Checks the collapsed navigation experience.",
  previewSummaryUpdatedAt: now,
  titleSource: "generated",
  createdAt: now,
  updatedAt: now,
};

test.describe("desktop sidebar rail", () => {
  test("persists the user's collapse choice across reloads", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "desktop-only layout");

    await installMockComparativeApi(page, { threads: [sidebarThread] });
    await gotoE2EChat(page);
    await resetSidebarPreference(page);

    const sidebar = page.locator("#primary-sidebar");
    await expect(sidebar).toHaveAttribute("data-sidebar-state", "expanded");
    await expectSidebarWidth(sidebar, 248);

    await sidebar.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(sidebar).toHaveAttribute("data-sidebar-state", "rail");
    await expectSidebarWidth(sidebar, 56);
    await expect(
      sidebar.getByRole("button", { name: "Sidebar rail acceptance" }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole("button", { name: "New chat" }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: "Search", exact: true }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("link", { name: "Skills", exact: true }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("link", { name: "Apps", exact: true }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: "Account menu" }),
    ).toBeVisible();
    await expect
      .poll(() => readSidebarPreference(page))
      .toBe("true");

    await page.reload();
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();
    await expect(sidebar).toHaveAttribute("data-sidebar-state", "rail");
    await expectSidebarWidth(sidebar, 56);

    await page.keyboard.press("Control+Backslash");
    await expect(sidebar).toHaveAttribute("data-sidebar-state", "expanded");
    await expectSidebarWidth(sidebar, 248);
    await expect
      .poll(() => readSidebarPreference(page))
      .toBe("false");
  });

  test("temporarily collapses for a tablet pane without changing the saved choice", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "tablet-only layout");

    await page.setViewportSize({ width: 1_000, height: 800 });
    await installMockComparativeApi(page, { threads: [sidebarThread] });
    await gotoE2EChat(page);
    await resetSidebarPreference(page);

    const sidebar = page.locator("#primary-sidebar");
    await expect(sidebar).toHaveAttribute("data-sidebar-state", "expanded");
    await openNavItem(page, "Artifacts", false);

    await expect(page.getByTestId("artifacts-pane")).toBeVisible();
    await expect(sidebar).toHaveAttribute("data-sidebar-state", "rail");
    await expect(sidebar).toHaveAttribute("data-auto-collapsed", "true");
    await expectSidebarWidth(sidebar, 56);
    await expect.poll(() => readSidebarPreference(page)).toBeNull();

    await page.getByRole("button", { name: "Close workspace" }).click();
    await expect(page.getByTestId("artifacts-pane")).toHaveCount(0);
    await expect(sidebar).toHaveAttribute("data-sidebar-state", "expanded");
    await expect(sidebar).not.toHaveAttribute("data-auto-collapsed", "true");
    await expectSidebarWidth(sidebar, 248);
    await expect.poll(() => readSidebarPreference(page)).toBeNull();
  });
});

async function resetSidebarPreference(page: Page) {
  await page.evaluate(
    (key) => window.localStorage.removeItem(key),
    SIDEBAR_COLLAPSED_STORAGE_KEY,
  );
  await page.reload();
  await expect(page.getByTestId("chat-empty-state")).toBeVisible();
}

async function readSidebarPreference(page: Page) {
  return page.evaluate(
    (key) => window.localStorage.getItem(key),
    SIDEBAR_COLLAPSED_STORAGE_KEY,
  );
}

async function expectSidebarWidth(
  sidebar: Locator,
  expected: number,
) {
  await expect
    .poll(() =>
      sidebar.evaluate((element) =>
        Math.round(element.getBoundingClientRect().width),
      ),
    )
    .toBe(expected);
}
