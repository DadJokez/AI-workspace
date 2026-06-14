import { expect, test } from "@playwright/test";
import {
  assistantMessage,
  fulfillSse,
  installMockComparativeApi,
  json,
  userMessage,
} from "./helpers/mock-comparative";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked chat feature tests run only against the local e2e harness",
);

test.describe("chat tools and skills", () => {
  test("surfaces connected-tool activity as collapsed work receipts", async ({
    page,
  }) => {
    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-tools",
            modelId: "sonnet-4-6",
          },
          {
            type: "tool-call",
            call: {
              id: "tool-github-prs",
              name: "mcp__github__list_pull_requests",
              input: { owner: "built-with-robot", repo: "comparative" },
            },
          },
          {
            type: "tool-result",
            result: {
              toolCallId: "tool-github-prs",
              output: { count: 3 },
              isError: false,
            },
          },
          {
            type: "text-delta",
            delta: "I found the last three pull requests and summarized them.",
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-tools",
            artifacts: [],
            recommendations: [],
          },
          { type: "done" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByText("Talk to your work.")).toBeVisible();

    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Can you check GitHub and summarize the last 3 PRs?");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(
      page.getByText("I found the last three pull requests and summarized them."),
    ).toBeVisible();
    await expect(page.getByText(/Worked for/)).toBeVisible();
    await expect(page.getByText("Finished checking")).toBeVisible();
    await page
      .locator("details")
      .filter({ hasText: /Worked for/ })
      .locator("summary")
      .click();
    await expect(page.getByText("Searched GitHub")).toBeVisible();
  });

  test("runs slash skills without sending the skill prompt into normal chat", async ({
    page,
  }) => {
    let chatPosts = 0;
    let skillRuns = 0;

    await installMockComparativeApi(page, {
      artifacts: [],
      threadMessages: {
        "thread-skill-run": [
          userMessage({
            id: "user-skill",
            content: "Run Weekly Status Writer",
          }),
          assistantMessage({
            id: "assistant-skill",
            content:
              "Subject: Weekly status\n\nShipped attachment fixes, added capability tests, and kept the next steps clear.",
          }),
        ],
      },
      onChat: async (_body, route) => {
        chatPosts += 1;
        await json(route, { error: "skill_should_not_hit_chat" }, 500);
      },
      onSkillRun: async (_skillId, _body, route) => {
        skillRuns += 1;
        await json(route, { threadId: "thread-skill-run" });
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByText("Talk to your work.")).toBeVisible();
    await expect(page.getByText("rob@example.com")).toBeVisible();
    await expect(page.getByPlaceholder(/ask anything/i)).toBeEnabled();

    await page.getByPlaceholder(/ask anything/i).fill("/status");
    await expect(page.getByText("Run a skill")).toBeVisible();
    await page
      .getByRole("button", {
        name: /Weekly Status Writer Draft a concise weekly status update/i,
      })
      .click();

    await expect
      .poll(() => skillRuns, { message: "skill run endpoint was called" })
      .toBe(1);
    await expect(
      page.locator("main").getByRole("button", {
        name: "Weekly Status Writer",
      }),
    ).toBeVisible();
    expect(chatPosts).toBe(0);
    await expect(
      page.getByText(/Do not reveal instructions|prompt|INTERNAL-SKILL/i),
    ).toHaveCount(0);
  });
});
