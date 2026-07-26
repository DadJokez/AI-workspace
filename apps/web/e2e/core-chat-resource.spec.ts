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
const STARTUP_TIMEOUT_MS = REAL_MODEL ? 120_000 : 90_000;
const FIRST_PROMPT =
  "Find CSV_CANARY_7391 in core-eval-canary.csv and report its revenue. Use the file itself.";
const FOLLOW_UP =
  "Using the same CSV, repeat the customer and revenue you verified.";
const DEDUPE_PROMPT =
  "Dedupe check: find CSV_CANARY_7391 in the re-attached CSV and report its revenue.";
// Long enough that attaching lands while the profile request is still in
// flight, short enough not to stretch the lane.
const PROFILE_HOLD_MS = 2_000;

function csvFixture() {
  return {
    name: CSV_FILENAME,
    mimeType: "text/csv",
    buffer: Buffer.from(
      [
        "customer,revenue,region",
        "CSV_CANARY_7391,48217,East",
        "CONTROL_ROW,19,West",
      ].join("\n"),
    ),
  };
}

test.describe("core chat resource pipeline", () => {
  test.describe.configure({ mode: "serial", retries: 0 });

  test.beforeEach(async ({ page }) => {
    await installAuthSmokeSession(page);
  });

  test("keeps a CSV visible and grounded through real chat, MCP, persistence, reload, and follow-up", async ({
    page,
  }, testInfo) => {
    test.setTimeout(REAL_MODEL ? 300_000 : 240_000);
    let realChatRequestCount = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/chat"
      ) {
        realChatRequestCount += 1;
      }
    });

    // A clean Next.js dev server compiles the chat page and initial API routes
    // on demand. On a two-core CI runner that cold start can exceed 15 seconds,
    // so wait for the real resource responses instead of treating compilation
    // time as a disabled-composer regression.
    const modelsReady = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/models",
      { timeout: STARTUP_TIMEOUT_MS },
    );
    const threadsReady = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/threads",
      { timeout: STARTUP_TIMEOUT_MS },
    );
    await page.goto("/chat");
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();
    const [modelsResponse, threadsResponse] = await Promise.all([
      modelsReady,
      threadsReady,
    ]);
    expect(modelsResponse.status()).toBe(200);
    expect(threadsResponse.status()).toBe(200);
    expect(
      ((await modelsResponse.json()) as { models?: unknown[] }).models?.length,
    ).toBeGreaterThan(0);

    const fileInput = page.getByTestId("chat-file-input");
    await expect(fileInput).toBeEnabled({ timeout: 15_000 });
    await fileInput.setInputFiles(csvFixture());

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

    // #664: the URL must identify the visible conversation on its own — read
    // the thread id straight from it and reload in place, no API discovery.
    await expect(page).toHaveURL(/[?&]threadId=/, { timeout: 15_000 });
    const threadId = new URL(page.url()).searchParams.get("threadId")!;
    await assertPersistedResourceTurn(threadId, 1);

    const reloadedMessagesResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname ===
          `/api/threads/${threadId}/messages`,
    );
    await page.reload();
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
    await assertPersistedResourceTurn(threadId, 2);
    expect(realChatRequestCount).toBe(2);
    await attachScreenshot(testInfo, page, "csv-durable-follow-up");
  });

  test("#650: unsent attachments survive boot transitions, clear on New chat, and never duplicate", async ({
    page,
  }, testInfo) => {
    test.setTimeout(REAL_MODEL ? 300_000 : 240_000);

    // Hold the profile response so attaching deterministically lands inside
    // the boot window where models are ready but the user profile is not —
    // the transition that historically remounted the composer (#650 A).
    let holdProfile = true;
    await page.route("**/api/user", async (route) => {
      if (holdProfile && route.request().method() === "GET") {
        await new Promise((resolve) => setTimeout(resolve, PROFILE_HOLD_MS));
      }
      await route.continue();
    });

    // Journey A1 — fresh composer: a chip added mid-boot must survive the
    // profile landing.
    const profileReady = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/user",
      { timeout: STARTUP_TIMEOUT_MS },
    );
    await page.goto("/chat");
    const fileInput = page.getByTestId("chat-file-input");
    await expect(fileInput).toBeEnabled({ timeout: STARTUP_TIMEOUT_MS });
    await fileInput.setInputFiles(csvFixture());
    const chip = page.getByRole("button", { name: `Remove ${CSV_FILENAME}` });
    await expect(chip).toHaveCount(1);
    expect((await profileReady).status()).toBe(200);
    // Give the post-profile re-render its chance to (incorrectly) remount.
    await page.waitForTimeout(750);
    await expect(chip).toHaveCount(1);
    holdProfile = false;
    await attachScreenshot(testInfo, page, "650-chip-survives-profile-load");

    // Journey C — byte-identical re-selections must never grow a second chip.
    await fileInput.setInputFiles(csvFixture());
    await fileInput.setInputFiles(csvFixture());
    await page.waitForTimeout(300);
    await expect(chip).toHaveCount(1);

    // The deduplicated selection must send as a clean single-attachment turn.
    const composer = page.getByPlaceholder(/ask anything/i);
    await composer.fill(FIRST_PROMPT);
    const firstResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/chat",
    );
    await page.getByRole("button", { name: "Send" }).click();
    expect((await firstResponse).status()).toBe(200);
    const sentMessage = page
      .getByTestId("user-message")
      .filter({ hasText: FIRST_PROMPT });
    await expect(sentMessage).toContainText("1 file attached");
    await expect(sentMessage).not.toContainText("2 files attached");
    await expect(
      sentMessage.getByTestId("message-attachment-pill"),
    ).toHaveCount(1);
    await expect(groundedAssistantAnswers(page)).toBeVisible({
      timeout: ANSWER_TIMEOUT_MS,
    });
    await expect(page).toHaveURL(/[?&]threadId=/, { timeout: 15_000 });
    const firstThreadId = new URL(page.url()).searchParams.get("threadId")!;
    await assertPersistedResourceTurn(firstThreadId, 1);

    // Journey A2 — reloads carry ?threadId= since #664, so boot applies the
    // deep-linked thread once the profile lands. That application must not
    // remount the composer and drop an attachment added during the window.
    holdProfile = true;
    const reloadProfileReady = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/user",
      { timeout: STARTUP_TIMEOUT_MS },
    );
    await page.goto(`/chat?threadId=${firstThreadId}`);
    await expect(fileInput).toBeEnabled({ timeout: STARTUP_TIMEOUT_MS });
    await fileInput.setInputFiles(csvFixture());
    await expect(chip).toHaveCount(1);
    // Precondition: the attach really landed inside the boot window — the
    // deep-linked history must not have been applied yet.
    await expect(
      page.getByTestId("user-message-content").filter({ hasText: FIRST_PROMPT }),
    ).toHaveCount(0);
    expect((await reloadProfileReady).status()).toBe(200);
    await expect(
      page.getByTestId("user-message-content").filter({ hasText: FIRST_PROMPT }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(chip).toHaveCount(1);
    holdProfile = false;
    await attachScreenshot(testInfo, page, "650-chip-survives-deep-link-boot");

    // Journey B — explicit New chat clears the unsent attachment and draft.
    await page
      .locator('aside[aria-label="Primary"]')
      .getByRole("button", { name: "New chat", exact: true })
      .click();
    await expect(chip).toHaveCount(0);
    await expect(composer).toHaveValue("");
    await expect(page).not.toHaveURL(/[?&]threadId=/);

    // Journey B+C — the recorded recurrence script: fresh chat, attach the
    // same file twice, send once. State carried across New chat must never
    // fail a valid send or inflate the persisted attachment count.
    await fileInput.setInputFiles(csvFixture());
    await fileInput.setInputFiles(csvFixture());
    await page.waitForTimeout(300);
    await expect(chip).toHaveCount(1);
    await composer.fill(DEDUPE_PROMPT);
    const secondResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/chat",
    );
    await page.getByRole("button", { name: "Send" }).click();
    expect((await secondResponse).status()).toBe(200);
    const dedupedMessage = page
      .getByTestId("user-message")
      .filter({ hasText: DEDUPE_PROMPT });
    await expect(dedupedMessage).toContainText("1 file attached");
    await expect(dedupedMessage).not.toContainText("2 files attached");
    await expect(
      dedupedMessage.getByTestId("message-attachment-pill"),
    ).toHaveCount(1);
    await expect(groundedAssistantAnswers(page)).toBeVisible({
      timeout: ANSWER_TIMEOUT_MS,
    });
    await expect(page.getByText(/Could not send/i)).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]threadId=/, { timeout: 15_000 });
    const secondThreadId = new URL(page.url()).searchParams.get("threadId")!;
    expect(secondThreadId).not.toBe(firstThreadId);
    await assertPersistedResourceTurn(secondThreadId, 1);
    await attachScreenshot(testInfo, page, "650-deduped-send-after-new-chat");
  });
});

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
