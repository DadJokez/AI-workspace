import { expect, test } from "@playwright/test";
import {
  assistantMessage,
  installMockComparativeApi,
  userMessage,
  type MockNotification,
} from "./helpers/mock-comparative";
import { gotoE2EChat } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked notification tests run only against the local e2e harness",
);

const now = "2026-06-14T20:00:00.000Z";

function threadSummary(id: string, title: string) {
  return {
    id,
    title,
    defaultModelId: "sonnet-4-6",
    summary: null,
    summaryUpdatedAt: null,
    previewSummary: null,
    previewSummaryUpdatedAt: null,
    titleSource: "generated",
    createdAt: now,
    updatedAt: now,
  };
}

function runNotification(
  overrides: Partial<MockNotification> = {},
): MockNotification {
  return {
    id: "notification-1",
    type: "run_succeeded",
    title: "Weekly Status finished",
    body: "A scheduled run completed while you were away.",
    runId: "run-scheduled-1",
    threadId: "thread-scheduled",
    readAt: null,
    acceptedAt: null,
    createdAt: now,
    ...overrides,
  };
}

test.describe("notification center", () => {
  test("bell shows unread count and opening a notification lands on the run output", async ({
    page,
  }) => {
    await installMockComparativeApi(page, {
      threads: [threadSummary("thread-scheduled", "Weekly Status")],
      threadMessages: {
        "thread-scheduled": [
          userMessage({ id: "user-sched", content: "Run weekly status" }),
          assistantMessage({
            id: "assistant-sched",
            content: "Scheduled weekly status output.",
          }),
        ],
      },
      notifications: [runNotification()],
    });

    await gotoE2EChat(page);

    const bell = page.getByTestId("notification-bell");
    await expect(bell).toBeVisible();
    await expect(page.getByTestId("notification-badge")).toHaveText("1");

    const openRequest = page.waitForRequest(
      (req) =>
        req.url().includes("/api/notifications/notification-1/open") &&
        req.method() === "POST",
    );
    await bell.click();
    await expect(page.getByTestId("notification-list")).toBeVisible();
    await page.getByTestId("notification-notification-1").click();
    await openRequest;

    // Deep link: the run output thread is now the active conversation.
    await expect(
      page.locator("main").getByText("Scheduled weekly status output."),
    ).toBeVisible();
  });

  test("failed runs render distinguishably and mark-all-read clears the badge", async ({
    page,
  }) => {
    await installMockComparativeApi(page, {
      notifications: [
        runNotification({
          id: "notification-fail",
          type: "run_failed",
          title: "Weekly Status failed",
          body: "The scheduled run ended with an error.",
          threadId: null,
        }),
      ],
    });

    await gotoE2EChat(page);
    await expect(page.getByTestId("notification-badge")).toHaveText("1");

    await page.getByTestId("notification-bell").click();
    await expect(page.getByText("Weekly Status failed")).toBeVisible();

    await page.getByTestId("mark-all-read").click();
    await expect(page.getByTestId("mark-all-read")).toHaveCount(0);
  });

  test("digest rolls up runs and shares since last visit", async ({
    page,
  }) => {
    await installMockComparativeApi(page, {
      notifications: [],
      digest: {
        since: now,
        completedRuns: [
          {
            id: "run-1",
            status: "succeeded",
            skillName: "Weekly Status",
            skillSlug: "weekly-status",
            threadId: "thread-scheduled",
            error: null,
            completedAt: now,
          },
        ],
        failedRuns: [
          {
            id: "run-2",
            status: "failed",
            skillName: "Meeting Prep",
            skillSlug: "meeting-prep",
            threadId: null,
            error: "boom",
            completedAt: now,
          },
        ],
        newShares: [
          {
            id: "share-1",
            subjectType: "skill",
            subjectName: "Standup Digest",
            grantedByName: "Nina",
            createdAt: now,
          },
        ],
      },
    });

    await gotoE2EChat(page);
    await page.getByTestId("notification-bell").click();

    const digest = page.getByTestId("daily-digest");
    await expect(digest).toBeVisible();
    await expect(digest.getByText("Weekly Status finished")).toBeVisible();
    await expect(digest.getByText("Meeting Prep failed")).toBeVisible();
    await expect(
      digest.getByText("Nina shared a skill: Standup Digest"),
    ).toBeVisible();
  });
});
