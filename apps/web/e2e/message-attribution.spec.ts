import { expect, test } from "@playwright/test";
import {
  assistantMessage,
  installMockComparativeApi,
  now,
  userMessage,
} from "./helpers/mock-comparative";
import { gotoE2EChat, openPrimarySidebar } from "./helpers/navigation";

test("shows honest model, lane, and message timestamps", async ({
  page,
  isMobile,
}) => {
  await installMockComparativeApi(page, {
    threads: [
      {
        id: "thread-attribution",
        title: "Attribution check",
        defaultModelId: "sonnet-4-6",
        summary: null,
        summaryUpdatedAt: null,
        previewSummary: null,
        previewSummaryUpdatedAt: null,
        titleSource: "generated",
        createdAt: now,
        updatedAt: now,
      },
    ],
    threadMessages: {
      "thread-attribution": [
        userMessage({ id: "user-attribution", content: "Who answered?" }),
        assistantMessage({
          id: "assistant-attribution",
          content: "Claude Sonnet handled this turn.",
          runtimeLane: "tool-local",
        }),
      ],
    },
  });
  await gotoE2EChat(page);

  await expect(page.getByTestId("resolved-model-chip")).toContainText(
    "Auto model",
  );
  const sidebar = await openPrimarySidebar(page, isMobile);
  await sidebar
    .getByRole("button", { name: "Attribution check", exact: true })
    .click();

  const modelChip = page.getByTestId("resolved-model-chip");
  await expect(modelChip).toContainText("Claude Sonnet 4.6");
  await expect(modelChip).toContainText("Tools");
  await expect(modelChip).toHaveAttribute(
    "aria-label",
    "Resolved model: Claude Sonnet 4.6, Tools lane",
  );

  const assistantTime = page.getByTestId("assistant-message-time");
  await expect(assistantTime).toBeVisible();
  await expect(assistantTime).toHaveAttribute("datetime", now);
  await expect(assistantTime).toHaveAttribute("title", now);

  const userTime = page.getByTestId("user-message-time");
  await expect(userTime).toHaveAttribute("datetime", now);
  await expect(userTime).toHaveAttribute("title", now);
  if (!isMobile) {
    await expect(userTime).toHaveCSS("opacity", "0");
    await page.getByTestId("user-message").hover();
    await expect(userTime).toHaveCSS("opacity", "1");
  }
});
