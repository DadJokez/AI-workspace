import { expect, test } from "@playwright/test";
import { installMockComparativeApi } from "./helpers/mock-comparative";
import { gotoE2EChat, openNavItem } from "./helpers/navigation";

test("theme toggle repro", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ui-skin", "umber"));
  await installMockComparativeApi(page);
  await gotoE2EChat(page);

  const html = page.locator("html");
  const dark = async () =>
    (await html.getAttribute("class"))?.includes("dark") ?? false;
  console.log("initial dark:", await dark(), "stored:", await page.evaluate(() => localStorage.getItem("theme")));

  // Top-bar sun/moon
  const toggle = page.getByRole("button", { name: /Switch to (light|dark) mode/ });
  console.log("toggle count:", await toggle.count());
  if (await toggle.count()) {
    await toggle.first().click();
    await page.waitForTimeout(300);
    console.log("after toggle dark:", await dark(), "stored:", await page.evaluate(() => localStorage.getItem("theme")));
    await toggle.first().click();
    await page.waitForTimeout(300);
    console.log("after 2nd toggle dark:", await dark(), "stored:", await page.evaluate(() => localStorage.getItem("theme")));
  }

  // Settings segmented control
  await openNavItem(page, "Settings", false);
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await page.waitForTimeout(300);
  console.log("settings Dark → dark:", await dark(), "stored:", await page.evaluate(() => localStorage.getItem("theme")));
  await page.getByRole("radio", { name: "Light", exact: true }).click();
  await page.waitForTimeout(300);
  console.log("settings Light → dark:", await dark(), "stored:", await page.evaluate(() => localStorage.getItem("theme")));
  await page.getByRole("radio", { name: "System", exact: true }).click();
  await page.waitForTimeout(300);
  console.log("settings System → dark:", await dark(), "stored:", await page.evaluate(() => localStorage.getItem("theme")));
  // and the topbar toggle again AFTER settings interaction
  const t2 = page.getByRole("button", { name: /Switch to (light|dark) mode/ });
  if (await t2.count()) { await t2.first().click(); await page.waitForTimeout(300);
    console.log("topbar after settings → dark:", await dark(), "stored:", await page.evaluate(() => localStorage.getItem("theme"))); }
  expect(true).toBe(true);
});
