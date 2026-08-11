import { expect, test, type Page, type Route } from "@playwright/test";
import {
  assistantMessage,
  defaultArtifactDetail,
  defaultArtifactSummary,
  fulfillSse,
  installMockComparativeApi,
  now,
  userMessage,
} from "./helpers/mock-comparative";
import { gotoE2EChat, openPrimarySidebar } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked thread-branching tests run only against the local e2e harness",
);

const sourceThreadId = "00000000-0000-4000-8000-000000000741";
const sourceUserMessageId = "00000000-0000-4000-8000-000000000742";
const sourceAssistantMessageId = "00000000-0000-4000-8000-000000000743";
const sourceArtifact = {
  ...defaultArtifactSummary,
  id: "00000000-0000-4000-8000-000000000744",
  title: "Launch plan",
  filename: "launch-plan.html",
  threadId: sourceThreadId,
  chatMessageId: sourceAssistantMessageId,
  artifactGroupId: "launch-plan",
};
const sourceArtifactDetail = {
  ...defaultArtifactDetail,
  ...sourceArtifact,
  content: "<!doctype html><html><body><h1>Launch plan</h1></body></html>",
};
const alternativeArtifact = {
  ...sourceArtifact,
  id: "00000000-0000-4000-8000-000000000746",
  title: "Partner-led launch plan",
  filename: "partner-launch-plan.html",
  threadId: "00000000-0000-4000-8000-000000000745",
  chatMessageId: "00000000-0000-4000-8000-000000000748",
  artifactGroupId: "partner-launch-plan",
};

test.describe("branch this work", () => {
  test("branches the current chat, shows lineage, and leaves the source unchanged", async ({
    page,
    isMobile,
  }) => {
    const harness = await installBranchHarness(page);
    await openSourceThread(page, isMobile);

    await page.getByTestId("branch-thread-button").click();

    await expect(page).toHaveURL(
      new RegExp(`threadId=${harness.branchThreadId}$`),
    );
    const lineage = page.getByTestId("branch-lineage-banner");
    await expect(lineage).toContainText("Alternative from");
    await expect(lineage).toContainText("Quarterly launch plan");
    await expect(lineage).toContainText("Chat snapshot");
    await expect(lineage).toContainText("2 messages");
    await expect(page.getByText("Build a launch plan.", { exact: true })).toBeVisible();
    await expect(page.getByText("Here is the launch plan.", { exact: true })).toBeVisible();
    expect(harness.requests).toEqual([
      { sourceType: "thread", sourceThreadId },
    ]);

    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Try a partner-led launch instead.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText("Here is the independent partner-led plan.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByTestId("artifact-pill").filter({
        hasText: alternativeArtifact.filename,
      }),
    ).toBeVisible();

    await lineage
      .getByRole("button", { name: "Quarterly launch plan" })
      .click();
    await expect(page).toHaveURL(new RegExp(`threadId=${sourceThreadId}$`));
    await expect(page.getByTestId("branch-lineage-banner")).toHaveCount(0);
    await expect(
      page.getByText("Here is the independent partner-led plan.", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(page.getByText(alternativeArtifact.filename)).toHaveCount(0);
    const alternatives = page.getByTestId("thread-alternatives");
    await expect(alternatives).toContainText("1 alternative");
    await expect(
      alternatives.getByRole("button", {
        name: "Alternative: Quarterly launch plan",
      }),
    ).toBeVisible();
    await expect(page.getByText("Build a launch plan.", { exact: true })).toBeVisible();
  });

  test("branches from an exact message and makes snapshot messages immutable", async ({
    page,
    isMobile,
  }) => {
    const harness = await installBranchHarness(page);
    await openSourceThread(page, isMobile);

    await page
      .getByTestId("assistant-message")
      .getByRole("button", { name: "Try another approach from here" })
      .click();

    await expect(page).toHaveURL(
      new RegExp(`threadId=${harness.branchThreadId}$`),
    );
    expect(harness.requests).toEqual([
      {
        sourceType: "message",
        sourceThreadId,
        sourceMessageId: sourceAssistantMessageId,
      },
    ]);
    await expect(page.getByTestId("branch-lineage-banner")).toContainText(
      "Message snapshot",
    );
    await expect(
      page
        .getByTestId("assistant-message")
        .getByRole("button", { name: "Try another approach from here" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit message" })).toHaveCount(0);
  });

  test("branches from the file currently open in Contribution Studio", async ({
    page,
    isMobile,
  }) => {
    const harness = await installBranchHarness(page, { includeArtifact: true });
    await openSourceThread(page, isMobile);

    await page.getByTestId("artifact-pill").click();
    const studio = page.getByRole("complementary", {
      name: "Contribution Studio",
    });
    await expect(studio).toBeVisible();
    await studio
      .getByRole("button", { name: "Try another approach from this file" })
      .click();

    await expect(page).toHaveURL(
      new RegExp(`threadId=${harness.branchThreadId}$`),
    );
    expect(harness.requests).toEqual([
      {
        sourceType: "artifact",
        sourceThreadId,
        artifactId: sourceArtifact.id,
      },
    ]);
    await expect(page.getByTestId("branch-lineage-banner")).toContainText(
      "1 file",
    );
  });

  test("offers branching as a keyboard-first command", async ({
    page,
    isMobile,
  }) => {
    const harness = await installBranchHarness(page);
    await openSourceThread(page, isMobile);

    await page.keyboard.press("Control+K");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.getByRole("combobox").fill("Try another approach");
    await expect(
      palette.getByRole("option", { name: /Try another approach/ }),
    ).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(
      new RegExp(`threadId=${harness.branchThreadId}$`),
    );
    expect(harness.requests).toEqual([
      { sourceType: "thread", sourceThreadId },
    ]);
  });
});

async function installBranchHarness(
  page: Page,
  options: { includeArtifact?: boolean } = {},
) {
  const branchThreadId = "00000000-0000-4000-8000-000000000745";
  const artifactList = options.includeArtifact ? [sourceArtifact] : [];
  const sourceMessages = [
    userMessage({
      id: sourceUserMessageId,
      content: "Build a launch plan.",
    }),
    assistantMessage({
      id: sourceAssistantMessageId,
      content: "Here is the launch plan.",
      artifacts: artifactList,
    }),
  ];
  const threads: Array<Record<string, unknown>> = [
    {
      id: sourceThreadId,
      title: "Quarterly launch plan",
      defaultModelId: "sonnet-4-6",
      summary: null,
      summaryUpdatedAt: null,
      previewSummary: "Launch work and decisions.",
      previewSummaryUpdatedAt: now,
      titleSource: "generated",
      createdAt: now,
      updatedAt: now,
    },
  ];
  const threadMessages: Record<string, unknown[]> = {
    [sourceThreadId]: sourceMessages,
  };
  const threadLineages: Record<string, unknown> = {};
  const threadAlternatives: Record<string, unknown[]> = {
    [sourceThreadId]: [],
  };
  const requests: Array<Record<string, unknown>> = [];

  await installMockComparativeApi(page, {
    threads,
    threadMessages,
    threadLineages,
    threadAlternatives,
    artifacts: artifactList,
    artifactDetails: options.includeArtifact
      ? { [sourceArtifact.id]: sourceArtifactDetail }
      : {},
    onThreadBranch: async (body, route) => {
      requests.push(body);
      const branchThread = {
        id: branchThreadId,
        title: "Alternative: Quarterly launch plan",
        defaultModelId: "sonnet-4-6",
        summary: null,
        summaryUpdatedAt: null,
        previewSummary: "Alternative from Quarterly launch plan.",
        previewSummaryUpdatedAt: now,
        titleSource: "generated",
        createdAt: now,
        updatedAt: now,
      };
      const resources =
        body.sourceType === "artifact"
          ? [
              {
                artifactIdSnapshot: sourceArtifact.id,
                artifactId: sourceArtifact.id,
                messageId: sourceAssistantMessageId,
                title: sourceArtifact.title,
                filename: sourceArtifact.filename,
                kind: sourceArtifact.kind,
                versionNumber: sourceArtifact.versionNumber,
                status: "available",
              },
            ]
          : [];
      const lineage = {
        sourceType: body.sourceType,
        sourceTitle: "Quarterly launch plan",
        parentThreadId: sourceThreadId,
        parentThreadIdSnapshot: sourceThreadId,
        branchPointMessageId:
          typeof body.sourceMessageId === "string" ? body.sourceMessageId : null,
        branchPointMessageIdSnapshot:
          typeof body.sourceMessageId === "string" ? body.sourceMessageId : null,
        sourceArtifactId:
          typeof body.artifactId === "string" ? body.artifactId : null,
        sourceArtifactIdSnapshot:
          typeof body.artifactId === "string" ? body.artifactId : null,
        sourceAppVersionId: null,
        sourceAppVersionIdSnapshot: null,
        messageCount: sourceMessages.length,
        resources,
        createdAt: now,
      };
      threads.push(branchThread);
      threadAlternatives[sourceThreadId] = [
        {
          threadId: branchThreadId,
          title: branchThread.title,
          sourceType: body.sourceType,
          createdAt: now,
        },
      ];
      threadMessages[branchThreadId] = sourceMessages.map((message) => ({
        ...message,
        branchSnapshot: true,
      }));
      threadLineages[branchThreadId] = lineage;
      await fulfillJson(route, {
        thread: branchThread,
        lineage,
        url: `/chat?threadId=${branchThreadId}`,
      });
    },
    onChat: async (body, route) => {
      const prompt = String(body.message ?? "");
      threadMessages[branchThreadId] = [
        ...(threadMessages[branchThreadId] ?? []),
        userMessage({
          id: "00000000-0000-4000-8000-000000000747",
          content: prompt,
        }),
        assistantMessage({
          id: "00000000-0000-4000-8000-000000000748",
          content: "Here is the independent partner-led plan.",
          artifacts: [alternativeArtifact],
        }),
      ];
      await fulfillSse(route, [
        {
          type: "meta",
          threadId: branchThreadId,
          userMessageId: "00000000-0000-4000-8000-000000000747",
          modelId: "sonnet-4-6",
        },
        {
          type: "text-delta",
          delta: "Here is the independent partner-led plan.",
        },
        {
          type: "persisted",
          assistantMessageId: "00000000-0000-4000-8000-000000000748",
          artifacts: [alternativeArtifact],
          recommendations: [],
        },
        { type: "done", stopReason: "completed" },
      ]);
    },
  });

  return { branchThreadId, requests };
}

async function openSourceThread(page: Page, isMobile: boolean) {
  await gotoE2EChat(page);
  const sidebar = await openPrimarySidebar(page, isMobile);
  await sidebar
    .getByRole("button", { name: "Quarterly launch plan", exact: true })
    .click();
  await expect(page.getByText("Here is the launch plan.", { exact: true })).toBeVisible();
}

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 201,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}
