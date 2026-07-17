import { expect, test } from "@playwright/test";
import {
  assistantMessage,
  installMockComparativeApi,
  userMessage,
} from "./helpers/mock-comparative";
import { gotoE2EChat, openPrimarySidebar } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "meter rendering runs against the local mock harness only",
);

// #330: the per-turn cost meter renders from persisted usage on reload.
test("assistant messages show the token & cost meter from persisted usage", async ({
  page,
}, testInfo) => {
  const isMobile = testInfo.project.name.includes("mobile");
  await installMockComparativeApi(page, {
    threads: [
      {
        id: "t-meter",
        title: "meter chat",
        defaultModelId: "sonnet-4-6",
        summary: null,
        summaryUpdatedAt: null,
        previewSummary: null,
        previewSummaryUpdatedAt: null,
        titleSource: "generated",
        createdAt: "2026-06-14T20:00:00.000Z",
        updatedAt: "2026-06-14T20:00:00.000Z",
      },
    ],
    threadMessages: {
      "t-meter": [
        userMessage({ id: "u1", content: "summarize the roadmap" }),
        assistantMessage({
          id: "a1",
          content: "Here is the roadmap summary.",
          modelId: "sonnet-4-6",
          tokensIn: 21_533,
          tokensOut: 10,
        }),
      ],
    },
  });

  await gotoE2EChat(page);
  const sidebar = await openPrimarySidebar(page, isMobile);
  await sidebar.getByRole("button", { name: /meter chat/i }).click();
  await expect(page.getByText("21.5k tokens · \u2264$0.07")).toBeVisible();
});
