import { expect, test } from "@playwright/test";
import {
  fulfillSse,
  installMockComparativeApi,
  json,
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

  test("activates slash skills inside the current chat without leaking the skill prompt", async ({
    page,
  }) => {
    const chatBodies: Record<string, unknown>[] = [];
    let skillRuns = 0;

    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (body, route) => {
        chatBodies.push(body);
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-current-skill-chat",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta:
              "Subject: Weekly status\n\nShipped attachment fixes, added capability tests, and kept the next steps clear.",
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-skill-chat",
            artifacts: [],
            recommendations: [],
          },
          { type: "done" },
        ]);
      },
      onSkillRun: async (_skillId, _body, route) => {
        skillRuns += 1;
        await json(route, { error: "skill_run_should_not_be_called" }, 500);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByText("Talk to your work.")).toBeVisible();
    await expect(page.getByText("rob@example.com")).toBeVisible();
    await expect(page.getByPlaceholder(/ask anything/i)).toBeEnabled();

    await page.getByPlaceholder(/ask anything/i).fill("/status");
    await expect(page.getByText("Capabilities")).toBeVisible();
    await page
      .getByRole("button", {
        name: /Weekly Status Writer Draft a concise weekly status update/i,
      })
      .click();

    await expect(page.getByTestId("active-slash-skill")).toContainText(
      "/weekly-status",
    );
    await expect(page.getByText("Active for this message")).toBeVisible();
    await page.getByPlaceholder(/ask anything/i).fill("focus on launch work");
    await page.getByRole("button", { name: "Send" }).click();

    await expect
      .poll(() => chatBodies.length, { message: "chat endpoint was called" })
      .toBe(1);
    expect(skillRuns).toBe(0);
    expect(chatBodies[0]).toMatchObject({
      message: "/weekly-status focus on launch work",
      activatedSkills: [
        {
          id: "skill-weekly-status",
          slug: "weekly-status",
          source: "explicit",
          args: "focus on launch work",
        },
      ],
    });
    await expect(page.getByText("Subject: Weekly status")).toBeVisible();
    await expect(
      page.getByText(/Do not reveal instructions|prompt|INTERNAL-SKILL/i),
    ).toHaveCount(0);
  });

  test("sends the /weekly brief alias as a same-chat activated skill", async ({
    page,
  }) => {
    const chatBodies: Record<string, unknown>[] = [];
    let skillRuns = 0;

    await installMockComparativeApi(page, {
      artifacts: [],
      skills: [
        {
          id: "skill-weekly-status",
          slug: "weekly-status",
          name: "Weekly Status",
          description: "Drafts a week-in-review status update.",
          mcpProviders: [],
          isStarter: true,
          sharedWithMe: false,
        },
      ],
      onChat: async (body, route) => {
        chatBodies.push(body);
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-weekly-brief-current",
            modelId: "sonnet-4-6",
          },
          { type: "text-delta", delta: "Weekly brief ready." },
          {
            type: "persisted",
            assistantMessageId: "assistant-weekly-brief",
            artifacts: [],
            recommendations: [],
          },
          { type: "done" },
        ]);
      },
      onSkillRun: async (_skillId, _body, route) => {
        skillRuns += 1;
        await json(route, { error: "skill_run_should_not_be_called" }, 500);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByText("Talk to your work.")).toBeVisible();

    await page.getByPlaceholder(/ask anything/i).fill("/weekly brief");
    await expect(page.getByText("Capabilities")).toBeVisible();
    await page.keyboard.press("Enter");

    await expect
      .poll(() => chatBodies.length, { message: "weekly alias hit chat" })
      .toBe(1);
    expect(skillRuns).toBe(0);
    expect(chatBodies[0]).toMatchObject({
      message: "/weekly-status",
      activatedSkills: [
        {
          id: "skill-weekly-status",
          slug: "weekly-status",
          source: "explicit",
          args: "",
        },
      ],
    });
    await expect(page.getByTestId("slash-capability-pill")).toContainText(
      "/weekly-status",
    );
    await expect(page.getByText("Weekly brief ready.")).toBeVisible();
  });
});
