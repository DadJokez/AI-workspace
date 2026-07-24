import { expect, test } from "@playwright/test";
import { installMockComparativeApi } from "./helpers/mock-comparative";
import { gotoE2EChat, openSettingsSection } from "./helpers/navigation";

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

    await openSettingsSection(page, "Memory", isMobile);
    await expect(
      page.getByRole("heading", { name: "Memory", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("What Comparative has learned about Rob.")).toBeVisible();
    await expect(page.getByText("1 approved · 1 suggested")).toBeVisible();
    await expect(
      page
        .getByRole("heading", {
          name: "Preferred answer style",
          exact: true,
        })
        .first(),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "PR review automation", exact: true }),
    ).toBeVisible();
    const suggestedCard = page
      .getByTestId("vault-suggested-memory-card")
      .first();
    await expect(suggestedCard).toContainText("Cites user message");
    const approvedCard = page
      .getByTestId("vault-approved-memory-card")
      .first();
    await expect(approvedCard.getByText("Confidence 82%")).toBeVisible();
    await expect(approvedCard.getByText("User-stated")).toBeVisible();
    await expect(approvedCard.getByText("1 source message")).toBeVisible();
    await expect(
      approvedCard.getByRole("link", { name: "Source thread" }),
    ).toHaveAttribute("href", /thread-style-feedback/);

    await approvedCard.getByRole("button", { name: "Edit" }).click();
    await approvedCard
      .locator("textarea")
      .fill("Keep updates direct, practical, and grounded in evidence.");
    await approvedCard.getByRole("button", { name: "Save" }).click();
    await expect(
      page.getByText("grounded in evidence").first(),
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
      page
        .getByRole("heading", { name: "Current test focus", exact: true })
        .first(),
    ).toBeVisible();
    await expect(page.getByText("2 approved · 1 suggested")).toBeVisible();

    await page
      .locator("div")
      .filter({ hasText: "PR review automation" })
      .filter({ hasText: "Approve" })
      .first()
      .getByRole("button", { name: "Approve" })
      .click();

    await expect(page.getByText("No suggested updates.")).toBeVisible();
    await expect(page.getByText("3 approved · 0 suggested")).toBeVisible();
    await expect(page.getByText("PR review automation").first()).toBeVisible();
  });

  test("dismisses suggestions and archives approved memory", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page);
    await gotoE2EChat(page);

    await openSettingsSection(page, "Memory", isMobile);
    await expect(page.getByText("1 approved · 1 suggested")).toBeVisible();

    await page
      .locator("div")
      .filter({ hasText: "PR review automation" })
      .filter({ hasText: "Dismiss" })
      .first()
      .getByRole("button", { name: "Dismiss" })
      .click();
    await expect(page.getByText("No suggested updates.")).toBeVisible();
    await expect(page.getByText("1 approved · 0 suggested")).toBeVisible();

    await page
      .locator("div")
      .filter({ hasText: "Preferred answer style" })
      .filter({ hasText: "Archive" })
      .first()
      .getByRole("button", { name: "Archive" })
      .click();
    await expect(page.getByText("0 approved · 0 suggested")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "No memory yet", exact: true }),
    ).toBeVisible();
  });

  test("derives category labels for non-default manual facts", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page);
    await gotoE2EChat(page);

    const response = await page.evaluate(async () => {
      const res = await fetch("/api/vault/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Writing preference",
          bodyMd: "Rob wants terse bug reports.",
          category: "working_style",
        }),
      });
      return (await res.json()) as {
        memory?: { categoryLabel?: string };
      };
    });
    expect(response.memory?.categoryLabel).toBe("Working Style");

    await openSettingsSection(page, "Memory", isMobile);
    await expect(page.getByText("2 approved · 1 suggested")).toBeVisible();
    await expect(page.getByText("Working Style").first()).toBeVisible();
    await expect(
      page
        .getByRole("heading", { name: "Writing preference", exact: true })
        .first(),
    ).toBeVisible();
  });
});
