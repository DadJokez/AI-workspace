import { expect, test } from "@playwright/test";
import {
  assistantMessage,
  installMockComparativeApi,
  userMessage,
} from "./helpers/mock-comparative";
import {
  gotoE2EChat,
  openPrimarySidebar,
} from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "type-scale guardrails run only against the local e2e harness",
);

for (const theme of ["light", "dark"] as const) {
  test(`Umber type roles resolve in ${theme} mode`, async ({
    page,
    isMobile,
  }) => {
    await page.addInitScript((storedTheme) => {
      localStorage.setItem("theme", storedTheme);
    }, theme);
    await installMockComparativeApi(page, {
      threads: [
        {
          id: "thread-type-scale",
          title: "Type scale check",
          defaultModelId: "sonnet-4-6",
          summary: null,
          summaryUpdatedAt: null,
          previewSummary: null,
          previewSummaryUpdatedAt: null,
          titleSource: "generated",
          createdAt: "2026-07-21T12:00:00.000Z",
          updatedAt: "2026-07-21T12:00:00.000Z",
        },
      ],
      threadMessages: {
        "thread-type-scale": [
          userMessage({ id: "user-type-scale", content: "Hello there" }),
          assistantMessage({
            id: "assistant-type-scale",
            content: "A calm, readable response.",
          }),
        ],
      },
    });
    await gotoE2EChat(page);

    const headline = page.getByTestId("empty-state-greeting");
    await expect(headline).toHaveCSS("font-size", "33px");
    await expect(headline).toHaveCSS("font-family", /newsreader/i);

    const sidebar = await openPrimarySidebar(page, isMobile);
    const skills = sidebar.getByRole("link", { name: "Skills", exact: true });
    await expect(skills).toHaveCSS("font-size", "13px");
    await sidebar.getByRole("button", { name: "Type scale check" }).click();

    await expect(page.getByTestId("user-message-content")).toHaveCSS(
      "font-size",
      "15px",
    );
    await expect(page.getByTestId("assistant-message-content")).toHaveCSS(
      "font-size",
      "15px",
    );

    await page.goto("/login");
    const loginTitle = page.getByRole("heading", {
      name: "Comparative",
      exact: true,
    });
    await expect(loginTitle).toHaveCSS("font-size", "21px");
    await expect(loginTitle).toHaveCSS("font-family", /newsreader/i);
  });
}
