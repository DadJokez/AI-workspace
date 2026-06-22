import { expect, test } from "@playwright/test";
import {
  installMockComparativeApi,
  now,
  regularUser,
} from "./helpers/mock-comparative";
import { gotoE2EChat, openNavItem, openPrimarySidebar } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked persona surface tests run only against the local e2e harness",
);

test.describe("persona and workspace surfaces", () => {
  test("shows admin navigation for admin users", async ({
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
  });

  test("hides admin navigation for regular users", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page, { user: regularUser });
    await gotoE2EChat(page);

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
    const githubCard = page.getByTestId("tool-card-github");
    await expect(githubCard.getByText("GitHub")).toBeVisible();
    await expect(githubCard.getByText("Connected")).toBeVisible();
    await expect(githubCard.getByText("Ready in chat")).toBeVisible();
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
    const githubCard = page.getByTestId("tool-card-github");
    await expect(githubCard.getByText("Not connected")).toBeVisible();
    const connect = githubCard.getByRole("link", { name: "Connect" });
    await expect(connect).toHaveAttribute("href", "/api/oauth/github/start");
  });

  test("reports Notion connection states in Tools", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page, {
      oauthStatus: { github: false, notion: false },
    });
    await gotoE2EChat(page);

    await openNavItem(page, "Tools", isMobile);
    const notionCard = page.getByTestId("tool-card-notion");
    await expect(notionCard.getByText("Notion")).toBeVisible();
    await expect(notionCard.getByText("Not connected")).toBeVisible();
    await expect(notionCard.getByRole("link", { name: "Connect" }))
      .toHaveAttribute("href", "/api/oauth/notion/start");
  });

  test("prioritizes connected tools above disconnected tools", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page, {
      oauthStatus: { github: false, notion: true },
    });
    await gotoE2EChat(page);

    await openNavItem(page, "Tools", isMobile);
    const connectedSection = page.getByTestId("tools-section-connected");
    const availableSection = page.getByTestId("tools-section-available");

    await expect(connectedSection.getByTestId("tool-card-notion"))
      .toBeVisible();
    await expect(availableSection.getByTestId("tool-card-github"))
      .toBeVisible();

    const cardOrder = await page
      .locator('[data-testid^="tool-card-"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-testid")),
      );
    expect(cardOrder[0]).toBe("tool-card-notion");
    expect(cardOrder[1]).toBe("tool-card-github");
  });

  test("shows connected and failed Notion OAuth feedback in Tools", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page, {
      oauthStatus: { github: false, notion: true },
    });
    await gotoE2EChat(page);

    await openNavItem(page, "Tools", isMobile);
    const connectedCard = page.getByTestId("tool-card-notion");
    await expect(connectedCard.getByText("Connected")).toBeVisible();
    await expect(connectedCard.getByText("Ready in chat")).toBeVisible();
    await expect(connectedCard.getByRole("link", { name: "Reconnect" }))
      .toHaveAttribute("href", "/api/oauth/notion/start");

    await page.goto("/e2e/chat?connected=notion&error=invalid_state");
    await expect(page.getByRole("heading", { name: "Tools" })).toBeVisible();
    const failedCard = page.getByTestId("tool-card-notion");
    await expect(failedCard.getByText("Auth failed")).toBeVisible();
    await expect(failedCard.getByRole("link", { name: "Reconnect" }))
      .toHaveAttribute("href", "/api/oauth/notion/start");
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
