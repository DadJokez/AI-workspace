import { expect, test } from "@playwright/test";

import {
  assistantMessage,
  fulfillSse,
  installMockComparativeApi,
  userMessage,
} from "./helpers/mock-comparative";
import { gotoE2EChat, openPrimarySidebar } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked Context Shelf tests run only against the local e2e harness",
);

const threadId = "11111111-1111-4111-8111-111111111738";
const userMessageId = "22222222-2222-4222-8222-222222222738";
const reference = {
  version: 1 as const,
  kind: "vault_item" as const,
  resourceId: "memory-quarterly-priorities",
};
const searchResult = {
  reference,
  label: "Quarterly priorities",
  description: "Approved priorities and current focus",
  sourceLabel: "Vault",
};
const manifest = {
  version: 1 as const,
  items: [
    {
      reference,
      label: searchResult.label,
      sourceLabel: searchResult.sourceLabel,
      state: "included" as const,
      scope: "approved memory",
      contentChars: 84,
    },
  ],
};

test("selects @context, sends typed references, and restores the receipt on edit and reload", async ({
  page,
  isMobile,
}) => {
  const threadMessages: Record<string, unknown[]> = { [threadId]: [] };
  const requests: Array<Record<string, unknown>> = [];
  await installMockComparativeApi(page, {
    threads: [
      {
        id: threadId,
        title: "Context Shelf canary",
        defaultModelId: "sonnet-4-6",
        summary: null,
        summaryUpdatedAt: null,
        previewSummary: null,
        previewSummaryUpdatedAt: null,
        titleSource: "generated",
        createdAt: "2026-08-10T12:00:00.000Z",
        updatedAt: "2026-08-10T12:00:00.000Z",
      },
    ],
    threadMessages,
    contextResources: {
      results: [searchResult],
      scopes: [
        {
          scope: "google_mail",
          label: "Gmail",
          description: "Search mail threads",
          available: true,
        },
      ],
    },
    onChat: async (body, route) => {
      requests.push(body);
      const content = String(body.message ?? "");
      threadMessages[threadId] = [
        userMessage({
          id: userMessageId,
          content,
          contextResourceReferences: [reference],
          contextResourceManifest: manifest,
        }),
        assistantMessage({
          id: `assistant-context-${requests.length}`,
          content: "I used the selected priorities.",
          contextResourceManifest: manifest,
        }),
      ];
      await fulfillSse(route, [
        {
          type: "meta",
          threadId,
          userMessageId,
          modelId: "sonnet-4-6",
        },
        { type: "text-delta", delta: "I used the selected priorities." },
        {
          type: "persisted",
          assistantMessageId: `assistant-context-${requests.length}`,
          artifacts: [],
          recommendations: [],
          contextResourceManifest: manifest,
        },
        { type: "done", stopReason: "completed" },
      ]);
    },
  });

  await gotoE2EChat(page);
  const sidebar = await openPrimarySidebar(page, isMobile);
  await sidebar
    .getByRole("button", { name: "Context Shelf canary" })
    .click();
  if (isMobile) {
    await expect
      .poll(() =>
        sidebar.evaluate((element) =>
          element.classList.contains("translate-x-0"),
        ),
      )
      .toBe(false);
  }

  const composer = page.getByPlaceholder(/ask anything/i);
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  // Next's local-dev toolbar occupies the composer's lower-left corner on the
  // Pixel viewport. Production has no toolbar, so bypass only that test-only
  // overlay while still exercising the real button handler.
  const addContext = page.getByRole("button", { name: "Add context" });
  if (isMobile) {
    await addContext.evaluate((button: HTMLButtonElement) => button.click());
  } else {
    await addContext.click();
  }
  const palette = page.getByTestId("context-resource-palette");
  await expect(palette).toBeVisible();
  await palette
    .getByRole("button", { name: /Quarterly priorities/ })
    .click();
  await expect(page.getByTestId("selected-context-resources")).toContainText(
    "Quarterly priorities",
  );

  await composer.fill("Draft a status update from this context.");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByTestId("user-context-resources")).toContainText(
    "Quarterly priorities",
  );
  const receipt = page.getByTestId("context-resource-receipt");
  await expect(receipt).toContainText("Using Vault memory");
  await expect(receipt).not.toHaveAttribute("open", "");
  await receipt.locator("summary").click();
  await expect(receipt).toContainText("Included");
  expect(requests[0]).toMatchObject({
    message: "Draft a status update from this context.",
    threadId,
    resourceReferences: [reference],
  });

  await page.reload();
  const restoredUserMessage = page
    .getByTestId("user-message")
    .filter({ hasText: "Draft a status update from this context." });
  await expect(restoredUserMessage).toBeVisible();
  await expect(page.getByTestId("user-context-resources")).toContainText(
    "Quarterly priorities",
  );
  await expect(page.getByTestId("context-resource-receipt")).toContainText(
    "Using Vault memory",
  );

  await restoredUserMessage.hover();
  await restoredUserMessage
    .getByRole("button", { name: "Edit message" })
    .click();
  await expect(page.getByTestId("selected-context-resources")).toContainText(
    "Quarterly priorities",
  );
  await composer.fill("Draft a shorter status update from this context.");
  await page.getByRole("button", { name: "Send" }).click();

  expect(requests[1]).toMatchObject({
    message: "Draft a shorter status update from this context.",
    threadId,
    replaceMessageId: userMessageId,
    resourceReferences: [reference],
  });
});
