import {
  chatMessages,
  getDb,
  runs,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { and, asc, desc, eq } from "drizzle-orm";

import { authSmokeUser, installAuthSmokeSession } from "./helpers/auth";

test.skip(
  process.env.PLAYWRIGHT_CORE_EVAL !== "1" ||
    Boolean(process.env.PLAYWRIGHT_BASE_URL),
  "the core resource eval runs only against its local authenticated full-stack harness",
);

const CSV_FILENAME = "core-eval-canary.csv";
const CSV_CUSTOMER = "CSV_CANARY_7391";
const CSV_REVENUE = "48217";
const REAL_MODEL = process.env.PLAYWRIGHT_CORE_REAL_MODEL === "1";
const ANSWER_TIMEOUT_MS = REAL_MODEL ? 90_000 : 30_000;
const FIRST_PROMPT =
  "Find CSV_CANARY_7391 in core-eval-canary.csv and report its revenue. Use the file itself.";
const FOLLOW_UP =
  "Using the same CSV, repeat the customer and revenue you verified.";

test.describe("core chat resource pipeline", () => {
  test.describe.configure({ mode: "serial", retries: 0 });

  test.beforeEach(async ({ page }) => {
    await installAuthSmokeSession(page);
  });

  test("keeps a CSV visible and grounded through real chat, MCP, persistence, reload, and follow-up", async ({
    page,
  }, testInfo) => {
    test.setTimeout(REAL_MODEL ? 180_000 : 90_000);
    let realChatRequestCount = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/chat"
      ) {
        realChatRequestCount += 1;
      }
    });

    await page.goto("/chat");
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();

    const fileInput = page.getByTestId("chat-file-input");
    await expect(fileInput).toBeEnabled({ timeout: 15_000 });
    await fileInput.setInputFiles({
      name: CSV_FILENAME,
      mimeType: "text/csv",
      buffer: Buffer.from(
        [
          "customer,revenue,region",
          "CSV_CANARY_7391,48217,East",
          "CONTROL_ROW,19,West",
        ].join("\n"),
      ),
    });

    const composerAttachment = page
      .getByRole("button", { name: `Remove ${CSV_FILENAME}` })
      .locator("..");
    await expect(composerAttachment).toContainText(CSV_FILENAME);
    await attachScreenshot(testInfo, page, "csv-visible-before-send");

    await page.getByPlaceholder(/ask anything/i).fill(FIRST_PROMPT);
    const firstResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/chat",
    );
    await page.getByRole("button", { name: "Send" }).click();

    const accepted = await firstResponse;
    expect(accepted.status()).toBe(200);
    expect(accepted.headers()["content-type"]).toContain("text/event-stream");

    const sentMessage = page
      .getByTestId("user-message")
      .filter({ hasText: FIRST_PROMPT });
    const sentAttachment = sentMessage
      .getByTestId("message-attachment-pill")
      .filter({ hasText: CSV_FILENAME });
    await expect(sentAttachment).toBeVisible();
    await expect(
      groundedAssistantAnswers(page),
    ).toBeVisible({ timeout: ANSWER_TIMEOUT_MS });
    await expect(page.getByText(/Could not send|did not receive verified/i)).toHaveCount(
      0,
    );
    await attachScreenshot(testInfo, page, "csv-grounded-answer");

    const thread = await findCanaryThread(page);
    await assertPersistedResourceTurn(thread.id, 1);

    const reloadedMessagesResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname ===
          `/api/threads/${thread.id}/messages`,
    );
    await page.goto(`/chat?threadId=${thread.id}`);
    expect((await reloadedMessagesResponse).status()).toBe(200);
    await expect(
      page.getByTestId("user-message-content").filter({ hasText: FIRST_PROMPT }),
    ).toBeVisible({ timeout: 30_000 });
    const reloadedMessage = page
      .getByTestId("user-message")
      .filter({ hasText: FIRST_PROMPT });
    const persistedAttachment = reloadedMessage
      .getByTestId("message-attachment-pill")
      .filter({ hasText: CSV_FILENAME });
    await expect(persistedAttachment).toBeVisible();
    await expect(persistedAttachment).toHaveAttribute(
      "aria-label",
      `Open attached file ${CSV_FILENAME}`,
    );
    await attachScreenshot(testInfo, page, "csv-visible-after-reload");

    const followUpComposer = page.getByPlaceholder(/ask anything/i);
    await expect(followUpComposer).toBeEnabled();
    await followUpComposer.fill(FOLLOW_UP);
    const followUpResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/chat",
    );
    await page.getByRole("button", { name: "Send" }).click();
    expect((await followUpResponse).status()).toBe(200);

    const groundedAnswers = groundedAssistantAnswers(page);
    await expect(groundedAnswers).toHaveCount(2, {
      timeout: ANSWER_TIMEOUT_MS,
    });
    await assertPersistedResourceTurn(thread.id, 2);
    expect(realChatRequestCount).toBe(2);
    await attachScreenshot(testInfo, page, "csv-durable-follow-up");
  });
});

async function findCanaryThread(page: Page) {
  let found:
    | {
        id: string;
        title: string;
      }
    | undefined;
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/threads?scope=mine&limit=50");
        if (!response.ok()) return false;
        const body = (await response.json()) as {
          threads?: Array<{ id: string; title: string }>;
        };
        found = body.threads?.find((thread) =>
          normalizedReference(thread.title).includes(
            normalizedReference(CSV_CUSTOMER),
          ),
        );
        return Boolean(found);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return found!;
}

function normalizedReference(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function assertPersistedResourceTurn(
  threadId: string,
  expectedTurns: number,
) {
  const db = getDb();
  const artifacts = await db
    .select({
      id: workspaceArtifacts.id,
      filename: workspaceArtifacts.filename,
      content: workspaceArtifacts.content,
      metadata: workspaceArtifacts.metadata,
    })
    .from(workspaceArtifacts)
    .where(
      and(
        eq(workspaceArtifacts.userId, authSmokeUser.id),
        eq(workspaceArtifacts.threadId, threadId),
        eq(workspaceArtifacts.filename, CSV_FILENAME),
        eq(workspaceArtifacts.source, "user-upload"),
      ),
    )
    .orderBy(desc(workspaceArtifacts.createdAt));
  expect(artifacts).toHaveLength(1);
  const artifact = artifacts[0]!;
  const storedContent =
    isRecord(artifact.metadata) &&
    artifact.metadata.storageEncoding === "base64"
      ? Buffer.from(artifact.content, "base64").toString("utf8")
      : artifact.content;
  expect(storedContent).toContain(`${CSV_CUSTOMER},${CSV_REVENUE},East`);

  let runRows: Array<{ status: string; inputs: unknown }> = [];
  await expect
    .poll(
      async () => {
        runRows = await db
          .select({
            status: runs.status,
            inputs: runs.inputs,
          })
          .from(runs)
          .where(
            and(
              eq(runs.userId, authSmokeUser.id),
              eq(runs.threadId, threadId),
              eq(runs.skillSlug, "chat-turn"),
            ),
          )
          .orderBy(asc(runs.createdAt));
        return runRows.map((run) => run.status);
      },
      { timeout: ANSWER_TIMEOUT_MS },
    )
    .toEqual(Array.from({ length: expectedTurns }, () => "succeeded"));
  for (const run of runRows) {
    expect(run.inputs).toMatchObject({
      resourceResolution: {
        status: "selected",
        selected: [
          {
            resourceId: artifact.id,
            filename: CSV_FILENAME,
          },
        ],
      },
      requiredToolName: "resources__query",
    });
  }

  const assistantRows = await db
    .select({
      content: chatMessages.content,
      toolCalls: chatMessages.toolCalls,
      toolResults: chatMessages.toolResults,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        eq(chatMessages.role, "assistant"),
      ),
    )
    .orderBy(asc(chatMessages.createdAt));
  expect(assistantRows).toHaveLength(expectedTurns);
  for (const message of assistantRows) {
    expect(message.content).toContain(CSV_CUSTOMER);
    expect(message.content).toMatch(/48,?217/);
    expect(message.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "resources__query",
          input: expect.objectContaining({
            resourceId: artifact.id,
            operation: "table_filter",
          }),
        }),
      ]),
    );
    const persistedResults = JSON.stringify(message.toolResults);
    expect(persistedResults).toContain(CSV_CUSTOMER);
    expect(persistedResults).toContain('"matchedRows":1');
    expect(persistedResults).toContain('"sourceCoverage":"full"');
    // Product persistence intentionally redacts returned rows; the final
    // answer above can contain the revenue only if the in-memory model
    // iteration saw it before this receipt was scrubbed.
    expect(persistedResults).toContain('"redacted":true');
  }
}

function groundedAssistantAnswers(page: Page) {
  return page
    .getByTestId("assistant-message-content")
    .filter({ hasText: CSV_CUSTOMER })
    .filter({ hasText: /48,?217/ });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function attachScreenshot(
  testInfo: TestInfo,
  page: Page,
  name: string,
) {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}
