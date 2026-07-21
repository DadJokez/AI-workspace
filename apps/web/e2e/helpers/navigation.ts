import { expect, type Page } from "@playwright/test";

export async function gotoE2EChat(page: Page) {
  await page.goto("/e2e/chat");
  await expect(page.getByText("Talk to your work.")).toBeVisible();
}

export async function openPrimarySidebar(page: Page, isMobile: boolean) {
  const sidebar = page.locator('aside[aria-label="Primary"]');
  if (isMobile) {
    const alreadyOpen = await sidebar.evaluate(async (element) => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      return element.classList.contains("translate-x-0");
    });
    if (!alreadyOpen) {
      const openMenu = page.getByRole("button", { name: "Open menu" }).first();
      await openMenu.click();
    }
    await expect
      .poll(() =>
        sidebar.evaluate((element) =>
          element.classList.contains("translate-x-0"),
        ),
      )
      .toBe(true);
  }

  if (isMobile) {
    await expect
      .poll(() =>
        sidebar.evaluate((element) => element.getBoundingClientRect().left),
      )
      .toBeGreaterThanOrEqual(-1);
  } else {
    await expect(sidebar).toBeVisible();
  }
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

export async function openSettingsSection(
  page: Page,
  section: string,
  isMobile: boolean,
) {
  const sidebar = await openPrimarySidebar(page, isMobile);
  await sidebar.getByRole("button", { name: "Account menu" }).click();
  await sidebar.getByRole("menuitem", { name: "Settings" }).click();

  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  if (section !== "Profile") {
    await dialog.getByRole("button", { name: section, exact: true }).click();
  }
  return dialog;
}
