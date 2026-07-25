import { expect, test } from "@playwright/test";
import {
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

test.describe("command palette", () => {
  test("searches personal workspace data and opens a thread in place", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page, {
      threads: [launchThread],
      skills: [
        {
          id: "skill-weekly-brief",
          slug: "weekly-brief",
          name: "Weekly brief",
          description: "Summarize the week for project stakeholders.",
        },
      ],
      apps: [
        {
          id: "app-launch-dashboard",
          slug: "launch-dashboard",
          name: "Launch dashboard",
          description: "Track release readiness.",
        },
      ],
    });
    await gotoE2EChat(page);

    const scopedRequest = page.waitForRequest((request) =>
      request.url().includes("/api/threads?limit=50&scope=mine"),
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
  });

  test("keeps admin destinations out of a regular user's results", async ({
    page,
  }) => {
    await installMockComparativeApi(page, { user: regularUser });
    await gotoE2EChat(page);
    await page.keyboard.press("Control+K");

    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("combobox").fill("Admin usage");
    await expect(dialog.getByText("No matching commands.")).toBeVisible();
    await expect(dialog.getByText("Admin", { exact: true })).toHaveCount(0);
  });
});
