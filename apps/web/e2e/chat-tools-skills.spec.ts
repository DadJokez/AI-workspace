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
      .first()
      .click();
    await expect(page.getByText("Searched GitHub")).toBeVisible();
  });

  test("keeps Gmail drafts and confirmed calendar writes in the current chat", async ({
    page,
  }) => {
    const chatBodies: Record<string, unknown>[] = [];
    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (body, route) => {
        chatBodies.push(body);
        const turn = chatBodies.length;
        const events =
          turn === 1
            ? [
                {
                  type: "tool-call",
                  call: {
                    id: "google-draft",
                    name: "google__create_draft",
                    input: {
                      to: ["nina@example.com"],
                      subject: "Q2 recap",
                      body: "The recap looks good.",
                    },
                  },
                },
                {
                  type: "tool-result",
                  result: {
                    toolCallId: "google-draft",
                    output: {
                      kind: "google_gmail_draft_created",
                      draftId: "draft-297",
                      sent: false,
                    },
                    isError: false,
                  },
                },
                {
                  type: "text-delta",
                  delta: "I saved the Gmail draft. It has not been sent.",
                },
              ]
            : turn === 2
              ? [
                  {
                    type: "tool-call",
                    call: {
                      id: "google-proposal",
                      name: "google__prepare_event",
                      input: {
                        title: "Q2 recap review",
                        start: "2026-07-10T15:00:00-04:00",
                        end: "2026-07-10T15:30:00-04:00",
                        timeZone: "America/New_York",
                        attendees: ["nina@example.com"],
                        sendInvitations: true,
                      },
                    },
                  },
                  {
                    type: "tool-result",
                    result: {
                      toolCallId: "google-proposal",
                      output: {
                        kind: "google_calendar_event_proposal",
                        proposalId: "proposal-297",
                        requiresConfirmation: true,
                      },
                      isError: false,
                    },
                  },
                  {
                    type: "text-delta",
                    delta:
                      "Q2 recap review, July 10 from 3:00–3:30 PM ET with Nina. Google will send an invitation. Create it?",
                  },
                ]
              : [
                  {
                    type: "tool-call",
                    call: {
                      id: "google-create-event",
                      name: "google__create_event",
                      input: {},
                    },
                  },
                  {
                    type: "tool-result",
                    result: {
                      toolCallId: "google-create-event",
                      output: {
                        kind: "google_calendar_event_created",
                        invitationsSent: true,
                        idempotentReplay: false,
                      },
                      isError: false,
                    },
                  },
                  {
                    type: "text-delta",
                    delta: "Created the event and sent Nina's invitation.",
                  },
                ];
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-google-writes",
            modelId: "sonnet-4-6",
          },
          ...events,
          {
            type: "persisted",
            assistantMessageId: `assistant-google-${turn}`,
            artifacts: [],
            recommendations: [],
          },
          { type: "done" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    const composer = page.getByPlaceholder(/ask anything/i);

    await composer.fill("Draft an email to Nina saying the Q2 recap looks good.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("I saved the Gmail draft. It has not been sent.")).toBeVisible();

    await composer.fill("Create a 30-minute Q2 recap review with Nina tomorrow at 3pm.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(/Google will send an invitation/)).toBeVisible();

    await composer.fill("Create the event.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Created the event and sent Nina's invitation.")).toBeVisible();

    expect(chatBodies.map((body) => body.message)).toEqual([
      "Draft an email to Nina saying the Q2 recap looks good.",
      "Create a 30-minute Q2 recap review with Nina tomorrow at 3pm.",
      "Create the event.",
    ]);
    await expect(page.getByTestId("chat-tab-strip")).toHaveCount(0);
    await expect(page.getByTestId("active-chat-title")).toBeVisible();
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
    await expect(page.getByTestId("chat-tab-strip")).toHaveCount(0);
    await expect(page.getByTestId("active-chat-title")).toContainText(
      "Weekly Status Writer",
    );
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
    await expect(page.getByTestId("active-slash-skill")).toContainText(
      "/weekly-status",
    );
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
    await expect(page.getByTestId("chat-tab-strip")).toHaveCount(0);
    await expect(page.getByTestId("active-chat-title")).toContainText(
      "Weekly Status",
    );
  });

  test("sends /model as a one-turn model override without activating a skill", async ({
    page,
  }) => {
    const chatBodies: Record<string, unknown>[] = [];

    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (body, route) => {
        chatBodies.push(body);
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-model-override",
            modelId: "haiku-4-5",
            modelOverride: true,
          },
          { type: "model", modelId: "haiku-4-5", modelOverride: true },
          { type: "text-delta", delta: "Quick answer from Haiku." },
          {
            type: "persisted",
            assistantMessageId: "assistant-model-override",
            artifacts: [],
            recommendations: [],
          },
          { type: "done" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByText("Talk to your work.")).toBeVisible();

    await page.getByPlaceholder(/ask anything/i).fill("/model haiku say hi");
    await expect(page.getByText("Capabilities")).toHaveCount(0);
    await page.getByRole("button", { name: "Send" }).click();

    await expect
      .poll(() => chatBodies.length, { message: "model override hit chat" })
      .toBe(1);
    expect(chatBodies[0]).toMatchObject({
      message: "/model haiku say hi",
      modelId: "haiku-4-5",
      modelOverride: true,
    });
    expect(chatBodies[0]?.activatedSkills).toBeUndefined();
    await expect(page.getByTestId("slash-capability-pill")).toContainText(
      "/model",
    );
    await expect(page.getByText("Quick answer from Haiku.")).toBeVisible();
    await expect(page.getByText("Thomas · haiku-4-5")).toBeVisible();
  });

  test("surfaces failed URL fetch tool work as an actionable receipt", async ({
    page,
  }) => {
    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-url-fetch-failed",
            modelId: "sonnet-4-6",
          },
          {
            type: "tool-call",
            call: {
              id: "tool-web-fetch",
              name: "web__fetch_url",
              input: { url: "https://example.com/" },
            },
          },
          {
            type: "tool-result",
            result: {
              toolCallId: "tool-web-fetch",
              output:
                'URL fetch failed for https://example.com/: content-type "image/png" is not readable text or HTML.',
              isError: true,
            },
          },
          {
            type: "text-delta",
            delta:
              'URL fetch failed for https://example.com/: content-type "image/png" is not readable text or HTML.',
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-url-fetch-failed",
            artifacts: [],
            recommendations: [],
          },
          { type: "done" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    await page
      .getByPlaceholder(/ask anything/i)
      .fill("https://example.com/ what is the html for this site?");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(
      page
        .getByTestId("assistant-message-content")
        .getByText(/content-type "image\/png"/),
    ).toBeVisible();
    await expect(page.getByText("1 step needs attention")).toBeVisible();
    await page
      .locator("details")
      .filter({ hasText: /Worked for/ })
      .locator("summary")
      .first()
      .click();
    await expect(page.getByText("Could not check Web details")).toBeVisible();
  });
});
