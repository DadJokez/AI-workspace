import { expect, test } from "@playwright/test";
import {
  assistantMessage,
  installMockComparativeApi,
  now,
  userMessage,
} from "./helpers/mock-comparative";
import {
  gotoE2EChat,
  openPrimarySidebar,
  openSettingsSection,
} from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked settings tests run only against the local e2e harness",
);

test.describe("settings modal", () => {
  test("opens over mounted chat, traps focus, and restores chat state", async ({
    page,
    isMobile,
  }) => {
    const threadId = "thread-settings-scroll";
    const messages = Array.from({ length: 18 }, (_, index) => [
      userMessage({
        id: `user-${index}`,
        content: `Question ${index}: give me a detailed project update.`,
      }),
      assistantMessage({
        id: `assistant-${index}`,
        content: `Answer ${index}: ${"A grounded status sentence. ".repeat(8)}`,
      }),
    ]).flat();
    await installMockComparativeApi(page, {
      threads: [
        {
          id: threadId,
          title: "Settings scroll preservation",
          defaultModelId: "sonnet-4-6",
          summary: "A long thread used to verify settings state.",
          previewSummary: "A long thread used to verify settings state.",
          summaryUpdatedAt: now,
          previewSummaryUpdatedAt: now,
          titleSource: "generated",
          createdAt: now,
          updatedAt: now,
        },
      ],
      threadMessages: { [threadId]: messages },
    });
    await gotoE2EChat(page);

    const sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar
      .getByRole("button", { name: "Settings scroll preservation" })
      .click();
    const scrollRegion = page.getByTestId("chat-scroll-region");
    await expect(page.getByText(/Answer 17/)).toBeVisible();
    await scrollRegion.evaluate((element) => {
      element.scrollTop = Math.max(120, element.scrollHeight / 3);
    });
    const scrollBefore = await scrollRegion.evaluate(
      (element) => element.scrollTop,
    );
    expect(scrollBefore).toBeGreaterThan(0);

    const composer = page.getByPlaceholder(/ask anything/i);
    await composer.focus();
    await page.keyboard.press("Control+,");

    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("chat-workspace-pane")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Profile", exact: true }),
    ).toBeFocused();

    const close = dialog.getByRole("button", { name: "Close settings" });
    await dialog.evaluate((element) => {
      const selector =
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
      const focusable = Array.from(
        element.querySelectorAll<HTMLElement>(selector),
      ).filter((candidate) => candidate.getClientRects().length > 0);
      focusable.at(-1)?.focus();
    });
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect
      .poll(() => scrollRegion.evaluate((element) => element.scrollTop))
      .toBe(scrollBefore);
  });

  test("warns before abandoning unsaved profile or instruction edits", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page);
    await gotoE2EChat(page);
    const dialog = await openSettingsSection(page, "Profile", isMobile);

    const name = dialog.getByLabel("Display name");
    await name.fill("Unsaved Rob");
    await dialog
      .getByRole("button", { name: "Appearance", exact: true })
      .click();
    const warning = page.getByRole("alertdialog", {
      name: "Discard unsaved changes?",
    });
    await expect(warning).toBeVisible();
    await warning.getByRole("button", { name: "Keep editing" }).click();
    await expect(name).toHaveValue("Unsaved Rob");

    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByText("Saved")).toBeVisible();
    await dialog
      .getByRole("button", { name: "Instructions", exact: true })
      .click();
    await dialog
      .getByLabel("How should Comparative work with you?")
      .fill("Keep this draft until I decide what to do.");
    await dialog
      .getByRole("button", { name: "Appearance", exact: true })
      .click();
    await warning.getByRole("button", { name: "Discard changes" }).click();
    await expect(
      dialog.getByRole("heading", { name: "Appearance" }),
    ).toBeVisible();
  });

  test("moves Memory and Integrations out of primary navigation", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page);
    await gotoE2EChat(page);
    const sidebar = await openPrimarySidebar(page, isMobile);

    await expect(
      sidebar.getByRole("button", { name: "Tools", exact: true }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole("button", { name: "Vault", exact: true }),
    ).toHaveCount(0);

    const accountMenu = sidebar.getByRole("button", { name: "Account menu" });
    const dialog = await openSettingsSection(page, "Integrations", isMobile);
    await expect(
      dialog.getByRole("heading", { name: "Integrations" }),
    ).toBeVisible();
    const microsoft = dialog.getByTestId("tool-card-microsoft-365");
    await microsoft.getByRole("button", { name: "Connect" }).click();
    const integrationDialog = page.getByRole("dialog", {
      name: "Microsoft 365",
    });
    await expect(integrationDialog.getByRole("button", { name: "Got it" }))
      .toBeFocused();
    await page.keyboard.press("Escape");
    await expect(integrationDialog).toHaveCount(0);
    await expect(dialog).toBeVisible();

    if (isMobile) {
      const box = await dialog.boundingBox();
      const viewport = page.viewportSize();
      expect(box).toBeTruthy();
      expect(viewport).toBeTruthy();
      expect(box?.width).toBe(viewport?.width);
      expect(box?.height).toBe(viewport?.height);
    }

    await dialog.getByRole("button", { name: "Close settings" }).click();
    await expect(accountMenu).toBeFocused();
  });
});
