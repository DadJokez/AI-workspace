import { expect, test } from "@playwright/test";
import {
  installMockComparativeApi,
  regularUser,
} from "./helpers/mock-comparative";
import { gotoE2EChat, openNavItem, openPrimarySidebar } from "./helpers/navigation";

const now = "2026-06-14T20:00:00.000Z";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked persona surface tests run only against the local e2e harness",
);

test.describe("persona and workspace surfaces", () => {
  test("shows admin navigation only for admin users", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page);
    await gotoE2EChat(page);

    const adminSidebar = await openPrimarySidebar(page, isMobile);
    await expect(adminSidebar.getByText("rob@example.com")).toBeVisible();
    await expect(
      adminSidebar.getByRole("button", { name: "Admin", exact: true }),
    ).toBeVisible();

    await page.unroute("**/api/**");
    await installMockComparativeApi(page, { user: regularUser });
    await page.reload();
    await expect(page.getByText("Talk to your work.")).toBeVisible();

    const regularSidebar = await openPrimarySidebar(page, isMobile);
    await expect(regularSidebar.getByText("casey@example.com")).toBeVisible();
    await expect(
      regularSidebar.getByRole("button", { name: "Admin", exact: true }),
    ).toHaveCount(0);
  });

  test("surfaces useful chat preview blurbs and filters useless ones", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page, {
      threads: [
        {
          id: "thread-magna-carta",
          title: "Magna Carta game updates",
          defaultModelId: "sonnet-4-6",
          summary:
            "Rob asked Comparative to revise a Magna Carta Jeopardy HTML app, create a new version, preserve the original, and verify the uploaded file path.",
          previewSummary:
            "Revised a Magna Carta Jeopardy app with versioned artifacts, upload handling, and a cleaner handoff back into chat.",
          summaryUpdatedAt: now,
          previewSummaryUpdatedAt: now,
          titleSource: "generated",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "thread-small-talk",
          title: "hello",
          defaultModelId: "haiku-4-5",
          summary: "hello",
          previewSummary: "hello",
          summaryUpdatedAt: now,
          previewSummaryUpdatedAt: now,
          titleSource: "first_message",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    await gotoE2EChat(page);
    const sidebar = await openPrimarySidebar(page, isMobile);
    const previewButton = sidebar.getByRole("button", {
      name: "Conversation preview",
    });

    await expect(previewButton).toHaveCount(1);
    await previewButton.focus();
    await expect(
      page.getByText(/versioned artifacts, upload handling/i),
    ).toBeVisible();
  });

  test("reports GitHub connection state in Tools", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page, {
      oauthStatus: { github: true },
    });
    await gotoE2EChat(page);

    await openNavItem(page, "Tools", isMobile);
    await expect(page.getByRole("heading", { name: "Tools" })).toBeVisible();
    await expect(page.getByText("GitHub")).toBeVisible();
    await expect(page.getByText("Connected")).toBeVisible();
    await expect(page.getByText("Linked to your account")).toBeVisible();
  });

  test("shows a connect link for disconnected GitHub", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page, {
      oauthStatus: { github: false },
    });
    await gotoE2EChat(page);

    await openNavItem(page, "Tools", isMobile);
    await expect(page.getByText("Not connected")).toBeVisible();
    const connect = page.getByRole("link", { name: "Connect" });
    await expect(connect).toHaveAttribute("href", "/api/oauth/github/start");
  });

  test("saves profile and custom instruction settings", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page);
    await gotoE2EChat(page);

    await openNavItem(page, "Settings", isMobile);
    const displayName = page.getByLabel("Display name");
    await expect(displayName).toHaveValue("Rob");

    await displayName.fill("Rob QA");
    await displayName.press("Enter");
    await expect(displayName).toHaveValue("Rob QA");
    await expect(
      page
        .locator("label")
        .filter({ hasText: "Display name" })
        .getByText("Saved"),
    ).toBeVisible();

    const instructionsField = page
      .locator("label")
      .filter({ hasText: "Tell the assistant about yourself" });
    await instructionsField
      .getByLabel(/Tell the assistant about yourself/i)
      .fill("Prefer concise regression notes with the risky bits called out.");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(instructionsField.getByText("Saved")).toBeVisible();
  });
});
