import { expect, test } from "@playwright/test";
import {
  assistantMessage,
  fulfillSse,
  installMockComparativeApi,
  json,
  now,
  userMessage,
} from "./helpers/mock-comparative";
import { gotoE2EChat, openPrimarySidebar } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked chat feature tests run only against the local e2e harness",
);

test.describe("chat tools and skills", () => {
  test("restores a durable tool approval after reload and continues in the same chat", async ({
    page,
  }, testInfo) => {
    const isMobile = testInfo.project.name.includes("mobile");
    const threadId = "thread-tool-approval";
    const runId = "run-tool-approval";
    const approvalId = "00000000-0000-4000-8000-000000000410";
    const messages: Record<string, unknown[]> = {
      [threadId]: [
        userMessage({
          id: "user-tool-approval",
          content: "Draft an email to the launch team.",
        }),
        assistantMessage({
          id: `run:${runId}`,
          content: "I have the draft ready and need permission to save it.",
          runId,
          runStatus: "waiting_for_approval",
          status: "Approval required",
          canCancel: true,
          approvalRequests: [
            {
              id: approvalId,
              batchId: "00000000-0000-4000-8000-000000000411",
              toolCallId: "gmail-draft-1",
              toolName: "gmail__draft_email",
              provider: "gmail",
              nativeToolName: "draft_email",
              redactedInput: {
                to: "launch@example.com",
                body: "[REDACTED]",
              },
              status: "pending",
              requestedAt: now,
              expiresAt: "2026-08-16T00:00:00.000Z",
              standingApprovalEligible: true,
            },
          ],
        }),
      ],
    };
    let submitted: { runId: string; body: Record<string, unknown> } | undefined;

    await installMockComparativeApi(page, {
      threads: [
        {
          id: threadId,
          title: "Launch email draft",
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
      threadMessages: messages,
      onToolApprovalDecision: async (submittedRunId, body, route) => {
        submitted = { runId: submittedRunId, body };
        messages[threadId] = [
          messages[threadId]![0]!,
          assistantMessage({
            id: `run:${runId}`,
            content: "",
            pending: true,
            status: "Queued...",
            runId,
            runStatus: "queued",
            canCancel: true,
          }),
        ];
        await json(route, {
          run: { id: runId, status: "queued" },
          approvals: [],
        });
      },
    });

    await gotoE2EChat(page);
    const sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar.getByRole("button", { name: "Launch email draft" }).click();
    await expect(page.getByTestId("tool-approval-card")).toBeVisible();

    await page.reload();
    const restoredSidebar = await openPrimarySidebar(page, isMobile);
    await restoredSidebar
      .getByRole("button", { name: "Launch email draft" })
      .click();
    const card = page.getByTestId("tool-approval-card");
    await expect(card).toBeVisible();
    await card.getByText("draft_email", { exact: true }).click();
    await expect(card).toContainText("[REDACTED]");
    await expect(card).not.toContainText("secret launch plan");

    await card
      .getByRole("checkbox", { name: /Allow this Skill/ })
      .check();
    await card.getByRole("button", { name: "Approve" }).click();
    await expect.poll(() => submitted).toEqual({
      runId,
      body: {
        decision: "approve",
        approvalIds: [approvalId],
        rememberForSkill: true,
      },
    });
    await expect(page.getByTestId("tool-approval-card")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  });

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
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();

    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Can you check GitHub and summarize the last 3 PRs?");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(
      page.getByText("I found the last three pull requests and summarized them."),
    ).toBeVisible();
    await expect(page.getByText(/Worked for/)).toBeVisible();
    const githubReceipt = page
      .locator("details")
      .filter({ hasText: /Worked for/ });
    await expect(githubReceipt.locator("summary").first()).toContainText(
      "Searched GitHub",
    );
    await githubReceipt.locator("summary").first().click();
    await expect(
      githubReceipt.getByText("Searched GitHub").last(),
    ).toBeVisible();
  });

  test("#359 reconstructs long-running worker telemetry after refresh", async ({
    page,
  }, testInfo) => {
    const isMobile = testInfo.project.name.includes("mobile");
    const threadId = "thread-worker-receipts";
    const runId = "run-worker-receipts";
    const startedAt = new Date(Date.now() - 4 * 60_000 - 12_000).toISOString();
    const thread = {
      id: threadId,
      title: "Build the quarterly dashboard",
      defaultModelId: "sonnet-4-6",
      summary: null,
      summaryUpdatedAt: null,
      previewSummary: null,
      previewSummaryUpdatedAt: null,
      titleSource: "generated",
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    const pendingMessage = assistantMessage({
      id: `run:${runId}`,
      content: "",
      pending: true,
      status: "Validating the app",
      runId,
      runStatus: "running",
      canCancel: true,
      runPhase: "validating",
      liveTokens: 8_400,
      createdAt: startedAt,
      activityEvents: [
        {
          id: "worker-started",
          state: "succeeded",
          label: "Background worker started the agent run",
          category: "progress",
          at: startedAt,
        },
        {
          id: "validation",
          state: "pending",
          label: "Validating app version",
          category: "workspace",
          at: new Date(Date.now() - 15_000).toISOString(),
        },
      ],
    });
    await installMockComparativeApi(page, {
      threads: [thread],
      threadMessages: {
        [threadId]: [
          userMessage({
            id: "user-worker-receipts",
            content: "Build the quarterly dashboard",
            createdAt: startedAt,
          }),
          pendingMessage,
        ],
      },
      runStatuses: {
        [runId]: {
          id: runId,
          status: "running",
          updatedAt: new Date().toISOString(),
          latestEventSequence: 2,
          liveTokens: 9_100,
        },
      },
    });

    async function openThread() {
      const sidebar = await openPrimarySidebar(page, isMobile);
      await sidebar
        .getByRole("button", { name: /build the quarterly dashboard/i })
        .click();
    }

    await gotoE2EChat(page);
    await openThread();
    await expect(page.getByText(/Working for 4m/)).toBeVisible();
    await expect(page.getByText(/9\.1k tokens/)).toBeVisible();
    await expect(page.getByText(/validating/).first()).toBeVisible();
    await expect(page.getByText("Validating app version").last()).toBeVisible();

    await page.reload();
    await openThread();
    await expect(page.getByText(/Working for 4m/)).toBeVisible();
    await expect(page.getByText(/9\.1k tokens/)).toBeVisible();
    await expect(page.getByText("Validating app version").last()).toBeVisible();
  });

  test("keeps natural Gmail draft follow-ups and confirmed calendar writes in the current chat", async ({
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
                  type: "text-delta",
                  delta:
                    "I prepared the recent PR email for Nina. It is ready to save.",
                },
              ]
            : turn === 2
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
              : turn === 3
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
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    const composer = page.getByPlaceholder(/ask anything/i);

    await composer.fill(
      "Can you pull recent PRs from my GitHub and draft an email to nina@example.com?",
    );
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText("I prepared the recent PR email for Nina. It is ready to save."),
    ).toBeVisible();

    await composer.fill("Ya, save it to Gmail.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText("I saved the Gmail draft. It has not been sent."),
    ).toBeVisible();

    await composer.fill("Create a 30-minute Q2 recap review with Nina tomorrow at 3pm.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(/Google will send an invitation/)).toBeVisible();

    await composer.fill("Yep.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Created the event and sent Nina's invitation.")).toBeVisible();

    expect(chatBodies.map((body) => body.message)).toEqual([
      "Can you pull recent PRs from my GitHub and draft an email to nina@example.com?",
      "Ya, save it to Gmail.",
      "Create a 30-minute Q2 recap review with Nina tomorrow at 3pm.",
      "Yep.",
    ]);
    await expect(page.getByTestId("chat-tab-strip")).toHaveCount(0);
    await expect(page.getByTestId("active-chat-title")).toBeVisible();
  });

  test("keeps incremental Gmail checks grounded in the current chat", async ({
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
                    id: "gmail-search-initial",
                    name: "google__search_mail",
                    input: {
                      query: "is:unread",
                      mailbox: "inbox",
                      sinceLastSearch: false,
                    },
                  },
                },
                {
                  type: "tool-result",
                  result: {
                    toolCallId: "gmail-search-initial",
                    output: { messageIds: ["message-a", "message-b"] },
                    isError: false,
                  },
                },
                {
                  type: "text-delta",
                  delta: "I found two unread inbox messages: Launch and Renewal.",
                },
              ]
            : turn === 2
              ? [
                  {
                    type: "tool-call",
                    call: {
                      id: "gmail-draft-follow-up",
                      name: "google__create_draft",
                      input: {
                        to: ["nina@example.com"],
                        subject: "Launch reply",
                        body: "Thanks, Nina. I will review it today.",
                      },
                    },
                  },
                  {
                    type: "tool-result",
                    result: {
                      toolCallId: "gmail-draft-follow-up",
                      output: { draftId: "draft-follow-up", sent: false },
                      isError: false,
                    },
                  },
                  {
                    type: "text-delta",
                    delta: "I saved the reply as a draft. It has not been sent.",
                  },
                ]
              : [
                  {
                    type: "tool-call",
                    call: {
                      id: "gmail-search-incremental",
                      name: "google__search_mail",
                      input: {
                        query: "",
                        mailbox: "inbox",
                        sinceLastSearch: true,
                      },
                    },
                  },
                  {
                    type: "tool-result",
                    result: {
                      toolCallId: "gmail-search-incremental",
                      output: { messageIds: ["message-c"] },
                      isError: false,
                    },
                  },
                  {
                    type: "text-delta",
                    delta:
                      "There is one genuinely new inbox message: Budget approval. The prior messages and your draft were not repeated.",
                  },
                ];

        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-google-incremental",
            modelId: "sonnet-4-6",
          },
          ...events,
          {
            type: "persisted",
            assistantMessageId: `assistant-google-incremental-${turn}`,
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    const composer = page.getByPlaceholder(/ask anything/i);

    await composer.fill("Check my unread inbox.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(/two unread inbox messages/)).toBeVisible();

    await composer.fill("Draft a reply to Nina saying I will review it today.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(/saved the reply as a draft/)).toBeVisible();

    await composer.fill("Anything new since your last update?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(/one genuinely new inbox message/)).toBeVisible();

    expect(chatBodies.map((body) => body.message)).toEqual([
      "Check my unread inbox.",
      "Draft a reply to Nina saying I will review it today.",
      "Anything new since your last update?",
    ]);
    await expect(page.getByRole("button", { name: "Open app" })).toHaveCount(0);
    await expect(page.getByTestId("chat-tab-strip")).toHaveCount(0);
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
          { type: "done", stopReason: "completed" },
        ]);
      },
      onSkillRun: async (_skillId, _body, route) => {
        skillRuns += 1;
        await json(route, { error: "skill_run_should_not_be_called" }, 500);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();
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
          { type: "done", stopReason: "completed" },
        ]);
      },
      onSkillRun: async (_skillId, _body, route) => {
        skillRuns += 1;
        await json(route, { error: "skill_run_should_not_be_called" }, 500);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();

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
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await page.goto("/e2e/chat");
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();

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
          { type: "done", stopReason: "completed" },
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
    const failedReceipt = page
      .locator("details")
      .filter({ hasText: /Worked for/ });
    await expect(failedReceipt.locator("summary").first()).toContainText(
      "Could not check Web details",
    );
    await failedReceipt.locator("summary").first().click();
    await expect(
      failedReceipt.getByText("Could not check Web details").last(),
    ).toBeVisible();
  });
});
