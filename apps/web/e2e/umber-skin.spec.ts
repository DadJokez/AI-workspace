import { expect, test } from "@playwright/test";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "skin opt-in is exercised against the local harness only",
);

// The opt-in mechanism is subtle: the pre-paint script applies skin-umber for
// the first frame, then React 19 hydration replaces <html>'s className and
// UiSkinSync must re-assert it. This locks the end state down — it fails if
// either half regresses (it did once: the class silently vanished after
// hydration before UiSkinSync existed).
test("ui-skin=umber survives hydration and remaps the palette", async ({
  page,
}) => {
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("ui-skin", "umber");
    localStorage.setItem("theme", "light");
  });
  await page.reload();
  await page.waitForLoadState("networkidle");

  await expect(page.locator("html")).toHaveClass(/skin-umber/);
  const canvas = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--color-canvas")
      .trim(),
  );
  expect(canvas).toBe("250 248 243"); // Umber --bg (neutral-50), not the default 247 246 243

  // And the default stays untouched without the opt-in.
  await page.evaluate(() => localStorage.removeItem("ui-skin"));
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("html")).not.toHaveClass(/skin-umber/);
});
