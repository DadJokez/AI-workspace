import { expect, type Page } from "@playwright/test";

export async function gotoE2EChat(page: Page) {
  await page.goto("/e2e/chat");
  await expect(page.getByText("Talk to your work.")).toBeVisible();
}

export async function openPrimarySidebar(page: Page, isMobile: boolean) {
  if (isMobile) {
    const openMenu = page.getByRole("button", { name: "Open menu" }).first();
    if (await openMenu.isVisible().catch(() => false)) {
      await openMenu.click();
    }
  }

  const sidebar = page.locator('aside[aria-label="Primary"]');
  await expect(sidebar).toBeVisible();
  return sidebar;
}

export async function openNavItem(
  page: Page,
  name: string,
  isMobile: boolean,
) {
  const sidebar = await openPrimarySidebar(page, isMobile);
  await sidebar.getByRole("button", { name, exact: true }).click();
}
