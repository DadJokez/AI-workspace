import { expect, test } from "@playwright/test";
import { installMockComparativeApi } from "./helpers/mock-comparative";
import { gotoE2EChat, openNavItem } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked Vault tests run only against the local e2e harness",
);

test.describe("Vault memory", () => {
  test("renders approved memory, adds a manual fact, and approves suggestions", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page);
    await gotoE2EChat(page);

    await openNavItem(page, "Vault", isMobile);
    await expect(
      page.getByRole("heading", { name: "Vault", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Rob" })).toBeVisible();
    await expect(page.getByText(/1 approved .* 1 suggested/)).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Preferred answer style",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "PR review automation", exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Add a fact" }).click();
    await page
      .getByPlaceholder(/Short title/i)
      .fill("Current test focus");
    await page
      .getByPlaceholder(/The fact/i)
      .fill("Rob wants broad Playwright coverage before bugs reach him.");
    await page.getByRole("button", { name: "Save fact" }).click();

    await expect(
      page.getByRole("heading", { name: "Current test focus", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/2 approved .* 1 suggested/)).toBeVisible();

    await page
      .locator("div")
      .filter({ hasText: "PR review automation" })
      .filter({ hasText: "Approve" })
      .first()
      .getByRole("button", { name: "Approve" })
      .click();

    await expect(page.getByText("No suggested updates.")).toBeVisible();
    await expect(page.getByText(/3 approved .* 0 suggested/)).toBeVisible();
    await expect(page.getByText("PR review automation").first()).toBeVisible();
  });
});
