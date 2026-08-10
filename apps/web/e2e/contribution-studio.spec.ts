import { expect, test } from "@playwright/test";
import {
  assistantMessage,
  defaultArtifactDetail,
  defaultArtifactSummary,
  installMockComparativeApi,
  now,
  userMessage,
} from "./helpers/mock-comparative";
import { gotoE2EChat, openPrimarySidebar } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked Contribution Studio tests run only against the local e2e harness",
);

const threadId = "thread-contribution-studio";
const runId = "00000000-0000-4000-8000-000000000740";
const foreignArtifact = {
  ...defaultArtifactSummary,
  id: "artifact-other-thread",
  title: "Other thread file",
  filename: "other-thread.md",
  kind: "markdown",
  mimeType: "text/markdown",
  threadId: "thread-other",
  artifactGroupId: "other-thread-file",
  previewUrl: "/api/workspace/artifacts/artifact-other-thread/preview",
  downloadUrl: "/api/workspace/artifacts/artifact-other-thread/download",
};

test.describe("Contribution Studio", () => {
  test("derives scoped tabs, evidence, and the Live Work Map without exposing private reasoning", async ({
    page,
    isMobile,
  }) => {
    await installMockComparativeApi(page, {
      threads: [
        {
          id: threadId,
          title: "Studio verification",
          defaultModelId: "sonnet-4-5",
          summary: null,
          summaryUpdatedAt: null,
          previewSummary: null,
          previewSummaryUpdatedAt: null,
          titleSource: "generated",
          createdAt: now,
          updatedAt: now,
        },
      ],
      artifacts: [defaultArtifactSummary, foreignArtifact],
      artifactDetails: {
        [defaultArtifactSummary.id]: defaultArtifactDetail,
      },
      threadMessages: {
        [threadId]: [
          userMessage({
            id: "studio-user",
            content: "Research this and make a brief.",
          }),
          assistantMessage({
            id: "studio-assistant",
            content: "The brief is ready.",
            runId,
            artifacts: [defaultArtifactSummary],
            providerReasoning: [
              {
                iteration: 1,
                blockIndex: 0,
                text: "private chain of thought",
                redacted: false,
              },
            ],
            sources: [
              {
                n: 1,
                title: "Public evidence",
                kind: "web",
                url: "https://example.com/evidence",
                toolCallId: "search-1",
              },
              {
                n: 2,
                title: "Blocked scheme",
                kind: "web",
                url: "javascript:alert(1)",
                toolCallId: "search-2",
              },
            ],
            activityEvents: [
              {
                id: "plan-1",
                state: "pending",
                label: "Queued research",
                category: "progress",
                at: "2026-06-14T19:59:55.000Z",
              },
              {
                id: "search-1",
                state: "pending",
                label: "Searching public evidence",
                category: "tools",
                at: "2026-06-14T19:59:56.000Z",
              },
              {
                id: "approval-1",
                state: "pending",
                label: "Waiting for approval",
                category: "tools",
                at: "2026-06-14T19:59:57.000Z",
              },
              {
                id: "crm-1",
                state: "failed",
                label: "Could not query CRM",
                category: "tools",
                at: "2026-06-14T19:59:58.000Z",
              },
              {
                id: "cancel-1",
                state: "succeeded",
                label: "Run canceled",
                category: "progress",
                at: "2026-06-14T19:59:59.000Z",
              },
              {
                id: "created-1",
                state: "succeeded",
                label: "Created brief",
                category: "workspace",
                at: now,
              },
            ],
          }),
        ],
      },
    });

    await gotoE2EChat(page);
    const sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar.getByRole("button", { name: "Studio verification" }).click();

    await page.getByRole("button", { name: "Show Contribution Studio" }).click();
    const studio = page.getByRole("complementary", {
      name: "Contribution Studio",
    });
    await expect(studio).toBeVisible();
    await expect(studio.getByRole("button", { name: "Preview" })).toBeVisible();
    await expect(studio.getByRole("button", { name: "Files" })).toBeVisible();
    await expect(studio.getByRole("button", { name: "Browser" })).toBeVisible();
    await expect(studio.getByRole("button", { name: "Activity" })).toBeVisible();
    await expect(studio.getByRole("button", { name: "Console" })).toHaveCount(0);

    await studio.getByRole("button", { name: "Files" }).click();
    await expect(studio.getByText("demo-artifact.html")).toBeVisible();
    await expect(studio.getByText("other-thread.md")).toHaveCount(0);

    await studio.getByRole("button", { name: "Browser" }).click();
    const publicEvidence = studio.getByRole("link", {
      name: "Open Public evidence",
    });
    await expect(publicEvidence).toHaveAttribute(
      "href",
      "https://example.com/evidence",
    );
    await expect(publicEvidence).toHaveAttribute("target", "_blank");
    await expect(
      studio.getByRole("link", { name: "Open Blocked scheme" }),
    ).toHaveCount(0);

    await studio.getByRole("button", { name: "Activity" }).click();
    const workMap = page.getByTestId("studio-work-map");
    for (const state of ["planned", "active", "waiting", "failed", "canceled"]) {
      await expect(workMap.locator(`[data-state="${state}"]`)).toHaveCount(1);
    }
    await expect(studio.getByText("Created brief")).not.toBeVisible();
    await expect(studio.getByText(/Completed details/)).toBeVisible();
    await expect(studio.getByText("private chain of thought")).toHaveCount(0);
    await expect(
      studio.getByRole("button", { name: "Inspect run" }).first(),
    ).toBeVisible();

    if (!isMobile) {
      const chat = page.getByTestId("chat-workspace-pane");
      const before = await studio.boundingBox();
      await studio.getByRole("button", { name: "Maximize Studio" }).click();
      const after = await studio.boundingBox();
      const chatBox = await chat.boundingBox();
      expect(before).toBeTruthy();
      expect(after).toBeTruthy();
      expect(chatBox).toBeTruthy();
      expect(after!.width).toBeGreaterThan(before!.width);
      expect(chatBox!.width).toBeGreaterThanOrEqual(400);
      expect(chatBox!.x + chatBox!.width).toBeLessThanOrEqual(after!.x + 1);
      await page
        .getByTestId("contribution-studio-resizer")
        .press("Shift+ArrowRight");
      const resized = await studio.boundingBox();
      expect(resized).toBeTruthy();
      expect(resized!.width).toBeLessThan(after!.width - 60);
      await expect(
        studio.getByRole("button", { name: "Maximize Studio" }),
      ).toBeVisible();
    }

    await studio
      .getByRole("button", { name: "Close Contribution Studio" })
      .click();
    await page.getByRole("button", { name: "Show Contribution Studio" }).click();
    await expect(
      page.getByRole("button", { name: "Activity" }),
    ).toHaveAttribute("aria-current", "page");
  });
});
