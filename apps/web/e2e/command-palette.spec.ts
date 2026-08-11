import { expect, test } from "@playwright/test";
import {
  defaultArtifactSummary,
  defaultVaultApproved,
  installMockComparativeApi,
  now,
  regularUser,
} from "./helpers/mock-comparative";
import { gotoE2EChat, openPrimarySidebar } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked command-palette tests run only against the local e2e harness",
);

const launchThread = {
  id: "thread-quarterly-launch",
  title: "Quarterly launch planning",
  defaultModelId: "sonnet-4-6",
  previewSummary: "Release milestones, owners, and launch dependencies.",
  previewSummaryUpdatedAt: now,
  titleSource: "generated",
  createdAt: now,
  updatedAt: now,
};

function commandPalette(
  items: unknown[],
  overrides: Record<string, unknown> = {},
) {
  return {
    items,
    isAdmin: false,
    partialSections: [],
    durationMs: 7.2,
    ...overrides,
  };
}

test.describe("command palette", () => {
  test("searches personal workspace data and opens a thread in place", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page, {
      threads: [launchThread],
      commandPalette: commandPalette([
        {
          id: `thread:${launchThread.id}`,
          group: "chats",
          label: launchThread.title,
          description: launchThread.previewSummary,
          priority: 20,
          command: {
            type: "thread",
            threadId: launchThread.id,
            title: launchThread.title,
          },
        },
      ]),
    });
    await gotoE2EChat(page);

    const scopedRequest = page.waitForRequest((request) =>
      request.url().includes("/api/command-palette"),
    );
    await page.keyboard.press("Control+K");
    await scopedRequest;

    const dialog = page.getByRole("dialog", { name: "Command palette" });
    const search = dialog.getByRole("combobox");
    await expect(dialog).toBeVisible();
    await expect(search).toBeFocused();
    await search.fill("Quarterly launch");
    await expect(dialog.getByText("Chats", { exact: true })).toBeVisible();
    await expect(
      dialog.getByRole("option", { name: /Quarterly launch planning/ }),
    ).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("active-chat-title")).toHaveText(
      "Quarterly launch planning",
    );
    await expect(page).toHaveURL(/\/e2e\/chat\?threadId=thread-quarterly-launch$/);

    const sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar.getByRole("button", { name: "Search", exact: true }).click();
    const reopened = page.getByRole("dialog", { name: "Command palette" });
    await expect(reopened).toBeVisible();

    const themeBefore = await page.locator("html").getAttribute("data-theme");
    await reopened.getByRole("combobox").fill("Toggle theme");
    await page.keyboard.press("Enter");
    await expect(reopened).toHaveCount(0);
    await expect
      .poll(() => page.locator("html").getAttribute("data-theme"))
      .not.toBe(themeBefore);

    await page.keyboard.press("Control+N");
    await expect(page.getByTestId("active-chat-title")).toHaveText("New chat");

    await page.keyboard.press("Control+K");
    const uploadPalette = page.getByRole("dialog", {
      name: "Command palette",
    });
    await uploadPalette.getByRole("combobox").fill("Upload a file");
    const fileChooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await fileChooser;
  });

  test("opens each global upload request only once", async ({ page }) => {
    await installMockComparativeApi(page);
    await gotoE2EChat(page);

    let fileChooserCount = 0;
    page.on("filechooser", () => {
      fileChooserCount += 1;
    });

    await page.keyboard.press("Control+K");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("combobox").fill("Upload a file");
    const firstFileChooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await firstFileChooser;
    expect(fileChooserCount).toBe(1);

    const composer = page.getByPlaceholder(/ask anything/i);
    await composer.fill("Finish a quick response.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Done.", { exact: true })).toBeVisible();
    await page.waitForTimeout(300);

    expect(fileChooserCount).toBe(1);
  });

  test("opens files and memory from permission-filtered workspace results", async ({
    page,
  }) => {
    await installMockComparativeApi(page, {
      threads: [
        {
          ...launchThread,
          id: "thread-generated",
          title: "Artifact planning",
        },
      ],
      commandPalette: commandPalette([
        {
          id: `artifact:${defaultArtifactSummary.id}`,
          group: "files",
          label: defaultArtifactSummary.title,
          description: defaultArtifactSummary.filename,
          command: {
            type: "artifact",
            artifact: { ...defaultArtifactSummary, metadata: null },
            threadTitle: "Artifact planning",
          },
        },
        {
          id: `vault:${defaultVaultApproved.id}`,
          group: "vault",
          label: defaultVaultApproved.title,
          description: defaultVaultApproved.bodyMd,
          command: {
            type: "settings",
            section: "memory",
            focusId: defaultVaultApproved.id,
          },
        },
      ]),
    });
    await gotoE2EChat(page);

    await page.keyboard.press("Control+K");
    let dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("combobox").fill("Demo Artifact");
    await expect(
      dialog.getByRole("option", { name: /Demo Artifact/ }),
    ).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");

    const studio = page.getByRole("complementary", {
      name: "Contribution Studio",
    });
    await expect(studio).toBeVisible();
    await expect(studio).toContainText(defaultArtifactSummary.filename);

    await page.keyboard.press("Control+K");
    dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("combobox").fill("Preferred answer style");
    await expect(
      dialog.getByRole("option", { name: /Preferred answer style/ }),
    ).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");

    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(
      settings.getByRole("heading", { name: "Memory", exact: true }),
    ).toBeVisible();
    await expect(
      settings.locator(`#memory-item-${defaultVaultApproved.id}`),
    ).toBeFocused();
  });

  test("runs a ready Skill in the current experience and explains tool readiness", async ({
    page,
  }) => {
    let skillRunCount = 0;
    await installMockComparativeApi(page, {
      commandPalette: commandPalette([
        {
          id: "skill:weekly-status",
          group: "skills",
          label: "Weekly Status Writer",
          description: "Draft a concise weekly status update.",
          readiness: {
            state: "ready",
            label: "Run",
            detail: "Run this Skill now.",
          },
          command: {
            type: "run-skill",
            skillId: "weekly-status",
            skillName: "Weekly Status Writer",
          },
        },
        {
          id: "provider:google",
          group: "tools",
          label: "Google Workspace",
          description: "Connect Google Workspace in Settings → Integrations.",
          readiness: {
            state: "connection_required",
            label: "Connect",
            detail: "Connect Google Workspace in Settings → Integrations.",
          },
          command: { type: "settings", section: "integrations" },
        },
      ]),
      onSkillRun: async (_skillId, _body, route) => {
        skillRunCount += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ threadId: "thread-skill-run" }),
        });
      },
    });
    await gotoE2EChat(page);

    await page.keyboard.press("Control+K");
    let dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("combobox").fill("Weekly Status Writer");
    const skill = dialog.getByRole("option", {
      name: /Weekly Status Writer.*Run/,
    });
    await expect(skill).toHaveAttribute("aria-describedby", /readiness/);
    await skill.click();
    await expect.poll(() => skillRunCount).toBe(1);
    await expect(page.getByTestId("active-chat-title")).toHaveText(
      "Skill: Weekly Status Writer",
    );

    await page.keyboard.press("Control+K");
    dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("combobox").fill("Google Workspace");
    const google = dialog.getByRole("option", {
      name: /Google Workspace.*Connect/,
    });
    await expect(google.locator('[title*="Settings"]')).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(
      page
        .getByRole("dialog", { name: "Settings" })
        .getByRole("heading", { name: "Integrations" }),
    ).toBeVisible();
  });

  test("opens immediately while workspace results load and offers retry on failure", async ({
    page,
  }) => {
    await installMockComparativeApi(page, {
      commandPaletteDelayMs: 500,
      commandPaletteStatus: 503,
      commandPalette: { error: "temporarily_unavailable" },
    });
    await gotoE2EChat(page);

    await page.keyboard.press("Control+K");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("option", { name: "New chat" })).toBeVisible();
    await expect(dialog.getByRole("listbox")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(dialog.getByRole("status")).toHaveText(
      "Workspace results unavailable",
    );
    await expect(
      dialog.getByRole("button", { name: "Retry workspace search" }),
    ).toBeVisible();
    await dialog.getByRole("combobox").fill("missing workspace result");
    await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("keeps admin destinations out of a regular user's results", async ({
    page,
  }) => {
    await installMockComparativeApi(page, {
      user: regularUser,
      commandPalette: commandPalette([], { isAdmin: false }),
    });
    await gotoE2EChat(page);
    await page.keyboard.press("Control+K");

    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("combobox").fill("Admin usage");
    await expect(dialog.getByText("No matching commands.")).toBeVisible();
    await expect(dialog.getByText("Admin", { exact: true })).toHaveCount(0);
  });
});
