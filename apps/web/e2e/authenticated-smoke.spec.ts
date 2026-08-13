import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getDb } from "@ai-workspace/db";
import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { authSmokeUser, installAuthSmokeSession } from "./helpers/auth";
import {
  defaultArtifactDetail,
  defaultArtifactSummary,
  fulfillSse,
  installMockComparativeApi,
} from "./helpers/mock-comparative";
import { openNavItem } from "./helpers/navigation";

test.skip(
  process.env.PLAYWRIGHT_AUTH_SMOKE !== "1" ||
    !!process.env.PLAYWRIGHT_BASE_URL,
  "authenticated smoke runs only through smoke:browser:auth with local seeded fixtures",
);

test.describe("authenticated product smoke", () => {
  // These tests intentionally share seeded database state. Retrying the whole
  // serial group would replay mutations against that already-advanced state.
  test.describe.configure({ mode: "serial", retries: 0 });

  test.beforeEach(async ({ page }) => {
    await installAuthSmokeSession(page);
  });

  test("opens protected chat, sends a simple turn, and uploads common files", async ({
    page,
  }) => {
    let capturedBody: Record<string, unknown> | undefined;

    await installMockComparativeApi(page, {
      artifacts: [],
      user: {
        id: authSmokeUser.id,
        email: authSmokeUser.email,
        displayName: authSmokeUser.displayName,
        name: authSmokeUser.displayName,
        role: authSmokeUser.role,
      },
      onChat: async (body, route) => {
        capturedBody = body;
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-auth-simple",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: "Authenticated smoke response streamed and persisted.",
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-auth-simple",
            artifacts: [],
            recommendations: [],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await page.goto("/chat");
    await expect(page.getByTestId("chat-empty-state")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Draft a concise project status update for my team",
      }),
    ).toBeVisible();

    const files = [
      { name: "screenshot.png", mimeType: "image/png" },
      { name: "brief.pdf", mimeType: "application/pdf" },
      {
        name: "requirements.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      {
        name: "forecast.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      {
        name: "deck.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      },
    ];
    const fileInput = page.getByTestId("chat-file-input");
    await expect(fileInput).toBeEnabled({ timeout: 15_000 });
    await fileInput.setInputFiles(
      files.map((file) => ({
        ...file,
        buffer: Buffer.from(`auth smoke content for ${file.name}`),
      })),
    );
    for (const file of files) {
      await expect(page.getByText(file.name)).toBeVisible();
    }

    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Summarize these signed-in smoke files.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(
      page.getByText("Authenticated smoke response streamed and persisted."),
    ).toBeVisible();
    expect(capturedBody?.attachmentCount).toBe(files.length);
    const attachments = capturedBody?.attachments as
      | Array<{ name?: unknown; dataBase64?: unknown }>
      | undefined;
    expect(attachments?.map((attachment) => attachment.name)).toEqual(
      files.map((file) => file.name),
    );
    expect(attachments?.every((attachment) => attachment.dataBase64)).toBe(
      true,
    );
  });

  test("shows generated artifacts, in-tab preview, recommendations, and transcript download", async ({
    page,
    isMobile,
  }) => {
    test.setTimeout(60_000);
    // Seeded by scripts/seed-auth-smoke.ts. The transcript download must hit
    // the REAL export route (#653), so the thread and its messages live in
    // Postgres instead of a threadExports mock.
    const exportThreadId = "00000000-0000-4000-8000-000000000260";
    const recommendation = {
      dbId: "recommendation-auth-deploy",
      id: "deploy-app:artifact-demo-html",
      type: "deploy_artifact_as_app",
      title: "Publish this as an app",
      reason:
        "The generated artifact looks reusable, so it can become a workspace app.",
      requiresApproval: true,
      action: { kind: "deploy_app", artifactId: defaultArtifactSummary.id },
      metadata: { artifactId: defaultArtifactSummary.id },
      status: "suggested",
      threadId: "thread-generated",
      chatMessageId: "assistant-generated",
      runId: "run-generated",
      createdAt: "2026-06-14T20:00:00.000Z",
      updatedAt: "2026-06-14T20:00:00.000Z",
    };

    await installMockComparativeApi(page, {
      artifacts: [defaultArtifactSummary],
      artifactDetails: {
        [defaultArtifactSummary.id]: {
          ...defaultArtifactDetail,
          content:
            "<!doctype html><html><body><h1>Auth Smoke Artifact</h1><p>Previewed in-tab.</p></body></html>",
        },
      },
      user: {
        id: authSmokeUser.id,
        email: authSmokeUser.email,
        displayName: authSmokeUser.displayName,
        name: authSmokeUser.displayName,
        role: authSmokeUser.role,
      },
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: exportThreadId,
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: [
              "Here is the generated app:",
              "",
              '```html filename="demo-artifact.html"',
              "<!doctype html><html><body><h1>Auth Smoke Artifact</h1></body></html>",
              "```",
            ].join("\n"),
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-generated",
            artifacts: [defaultArtifactSummary],
            recommendations: [recommendation],
          },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });

    await page.goto("/chat");
    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Build a signed-in auth smoke HTML artifact.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Document content collapsed")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /demo-artifact\.html/i }),
    ).toBeVisible();
    await expect(page.getByText("Publish this as an app")).toBeVisible();

    const previewBefore = page.context().pages().length;
    await page.getByRole("button", { name: /demo-artifact\.html/i }).click();
    await expect(
      page.getByRole("complementary", { name: "Contribution Studio" }),
    ).toBeVisible();
    await expect(
      page
        .frameLocator('aside[aria-label="Contribution Studio"] iframe')
        .getByRole("heading", { name: "Auth Smoke Artifact" }),
    ).toBeVisible();
    expect(page.context().pages()).toHaveLength(previewBefore);
    await page.getByRole("button", { name: "Close Contribution Studio" }).click();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download chat transcript" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(
      /^\d{4}-\d{2}-\d{2}-build-a-signed-in-auth-smoke-html-artifact\.md$/,
    );
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const transcript = await readFile(downloadPath!, "utf8");
    expect(transcript).toContain("Build a signed-in auth smoke HTML artifact.");
    expect(transcript).toContain("demo-artifact.html");

    if (isMobile) {
      await page.getByRole("button", { name: "Open menu" }).click();
    }
    await openNavItem(page, "Artifacts", isMobile);
    await expect(page.getByRole("heading", { name: "Artifacts" })).toBeVisible();
    await expect(
      page.getByTestId("contribution-studio").getByText(/demo-artifact\.html/),
    ).toBeVisible();

    await page.getByRole("button", { name: "Close Contribution Studio" }).click();
    await expect(page.getByText("Publish this as an app")).toBeVisible();
    const appManagementUrl =
      /\/apps\/manage\/00000000-0000-4000-8000-000000000230$/;
    const deployResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/apps") &&
        response.request().method() === "POST",
    );
    const deployNavigationPromise = page
      .waitForURL(appManagementUrl, { timeout: 30_000 })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Publish navigation did not complete. Current URL: ${page.url()}. ${message}`,
        );
      });
    await page.getByRole("button", { name: "Publish app" }).click();
    const deployResponse = await deployResponsePromise;
    expect(deployResponse.ok()).toBe(true);
    await deployNavigationPromise;
    await expect(page).toHaveURL(appManagementUrl);
  });

  test("manages app versions, sharing roles, and edit sessions", async ({
    page,
  }) => {
    await page.goto("/apps/manage/00000000-0000-4000-8000-000000000230");
    await expect(
      page.getByRole("heading", { name: "Auth Smoke App" }),
    ).toBeVisible();
    await expect(page.getByText("Current data mode:")).toContainText(
      "Snapshot",
    );

    const draftRow = page.locator("li").filter({ hasText: "v3" });
    await expect(draftRow).toContainText("Draft");
    await draftRow.getByRole("button", { name: "Publish" }).click();
    await expect(draftRow).toContainText("Published");

    const previousRow = page.locator("li").filter({ hasText: "v1" });
    await previousRow.getByRole("button", { name: "Publish" }).click();
    await expect(previousRow).toContainText("Published");

    const throwawayRow = page.locator("li").filter({ hasText: "v4" });
    await expect(throwawayRow).toContainText("Draft");
    await throwawayRow.getByRole("button", { name: "Discard" }).click();
    await expect(throwawayRow).toHaveCount(0);

    const unpublishRequest = page.waitForRequest(
      (request) =>
        request.url().endsWith("/publication") &&
        request.method() === "DELETE",
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Unpublish" }).click();
    await unpublishRequest;
    const republishResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/deploy") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Republish" }).click();
    expect((await republishResponse).ok()).toBe(true);
    await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible();

    const shareRow = page
      .locator("li")
      .filter({ hasText: "app-recipient@example.com" });
    const roleSelect = shareRow.locator("select");
    await expect(roleSelect).toHaveValue("viewer");
    await roleSelect.selectOption("editor");
    await expect(roleSelect).toHaveValue("editor");

    const [editResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response
            .url()
            .includes(
              "/api/apps/00000000-0000-4000-8000-000000000230/edit-sessions",
            ) && response.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Edit with Comparative" }).click(),
    ]);
    expect(editResponse.ok()).toBe(true);
    await expect(page).toHaveURL(/\/chat\?threadId=/, { timeout: 15_000 });
  });

  test("defaults app publication to a sealed snapshot", async ({ page }) => {
    await page.goto("/apps");
    await expect(
      page.getByRole("heading", { name: "Publish an app" }),
    ).toBeVisible();
    await expect(page.getByRole("radio", { name: "Snapshot" })).toBeChecked();
    await expect(
      page.getByRole("radio", { name: "Live via viewer" }),
    ).toBeDisabled();
    await expect(page.getByRole("button", { name: "Publish" })).toBeVisible();
  });

  test("shows publication provenance and kill controls to admins", async ({
    page,
  }) => {
    await page.goto("/admin/apps");
    await expect(
      page.getByRole("heading", { name: "Published apps" }),
    ).toBeVisible();
    const appRow = page.getByRole("row").filter({ hasText: "Auth Smoke App" });
    await expect(appRow).toContainText("Snapshot");
    await expect(
      appRow.getByRole("button", { name: "Unpublish" }),
    ).toBeVisible();
  });

  test("serves a published snapshot with truthful viewer provenance", async ({
    page,
  }) => {
    const response = await page.goto("/apps/auth-smoke-app");
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-security-policy"]).toContain(
      "connect-src 'none'",
    );
    await expect(
      page.getByRole("heading", { name: "Auth Smoke Previous" }),
    ).toBeVisible();
    const badge = page.getByRole("complementary", {
      name: "Comparative publication details",
    });
    await expect(badge).toContainText("Comparative");
    await expect(badge).toContainText("Snapshot");
    await expect(badge).toContainText("By Auth Smoke");
  });

  test("renders protected skills catalog with owned, shared, and starter skills", async ({
    page,
  }) => {
    await page.goto("/skills");

    await expect(
      page.getByRole("heading", { name: "Skill catalog" }),
    ).toBeVisible();
    await expect(page.getByText("Your skills")).toBeVisible();
    await expect(page.getByText("Auth Smoke Weekly Status")).toBeVisible();
    await expect(page.getByText("Shared with you")).toBeVisible();
    await expect(page.getByText("Auth Smoke Shared Review")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Starters" })).toBeVisible();
    await expect(page.getByText("Auth Smoke Starter Brief")).toBeVisible();
    await expect(page.getByText("Sonnet 4.5").first()).toBeVisible();
    await expect(page.getByText("sonnet-4-5", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/\(soon\) schedule and share/)).toHaveCount(0);
  });

  test("shows skill tool connection state without a fake pinned-model choice", async ({
    page,
  }) => {
    await page.route("**/api/oauth/status", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          providerDetails: {
            github: {
              connected: true,
              toolAvailable: true,
              status: "ready",
            },
            notion: {
              connected: false,
              toolAvailable: false,
              status: "not_connected",
            },
            google: {
              connected: false,
              toolAvailable: false,
              status: "not_connected",
            },
            salesforce: {
              connected: false,
              toolAvailable: false,
              status: "not_connected",
            },
          },
        }),
      });
    });

    await page.goto("/skills/new");

    await expect(page.getByLabel("Model")).toHaveCount(0);
    const githubRow = page.getByLabel("GitHub").locator("..").locator("..");
    await expect(githubRow).toContainText("Connected");
    const notionRow = page.getByLabel("Notion").locator("..").locator("..");
    await expect(notionRow).toContainText("Not connected");
    await expect(
      notionRow.getByRole("link", { name: "Connect in Settings" }),
    ).toHaveAttribute("href", "/chat?open=settings&section=integrations");
    await expect(page.getByLabel("Web access").locator("..").locator(".."))
      .toContainText("Built in");
  });

  test("scopes shared-skill run history to the signed-in user", async ({
    page,
  }) => {
    await page.goto("/skills/00000000-0000-4000-8000-000000000215");

    await expect(
      page.getByText("Current user's shared-skill failure."),
    ).toBeVisible();
    await expect(
      page.getByText("Private failure from another skill collaborator."),
    ).toHaveCount(0);
  });

  test("creates, runs, pauses, and deletes a signed GitHub skill trigger", async ({
    page,
  }) => {
    const skillId = "00000000-0000-4000-8000-000000000213";
    const webhookSecret = "playwright-github-webhook-secret";
    const payload = {
      action: "submitted",
      repository: { full_name: "DadJokez/AI-workspace" },
      pull_request: {
        number: 293,
        title: "Authenticated smoke review",
        html_url: "https://github.com/DadJokez/AI-workspace/pull/293",
        user: { login: "auth-smoke-author" },
        assignees: [{ login: "roblindmark" }],
      },
      review: {
        state: "approved",
        body: "Smoke review approved.",
        html_url:
          "https://github.com/DadJokez/AI-workspace/pull/293#review",
        user: { login: "auth-smoke-reviewer" },
      },
    };

    async function sendWebhook(deliveryId = randomUUID()) {
      const rawBody = JSON.stringify(payload);
      const signature = `sha256=${createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex")}`;
      return page.request.post("/api/webhooks/github", {
        headers: {
          "content-type": "application/json",
          "x-github-delivery": deliveryId,
          "x-github-event": "pull_request_review",
          "x-hub-signature-256": signature,
        },
        data: rawBody,
      });
    }

    await page.goto(`/skills/${skillId}`);
    await expect(
      page.getByRole("heading", { name: "GitHub triggers" }),
    ).toBeVisible();
    await page.getByLabel("Repository").fill("DadJokez/AI-workspace");
    await page.getByLabel("PR author").fill("auth-smoke-author");
    await page.getByLabel("PR assignee").fill("roblindmark");
    const [createResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/event-triggers") &&
          response.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Add trigger" }).click(),
    ]);
    expect(createResponse.status()).toBe(201);

    const triggerRow = page.locator("li").filter({
      hasText: "dadjokez/ai-workspace",
    });
    await expect(triggerRow).toContainText("Pull request review");
    await expect(triggerRow).toContainText("author @auth-smoke-author");

    const deliveryId = randomUUID();
    const webhookResponse = await sendWebhook(deliveryId);
    expect(webhookResponse.status()).toBe(202);
    expect(await webhookResponse.json()).toMatchObject({
      matched: 1,
      fired: 1,
      failed: 0,
    });
    const duplicateResponse = await sendWebhook(deliveryId);
    expect(duplicateResponse.status()).toBe(202);
    expect(await duplicateResponse.json()).toMatchObject({
      matched: 1,
      fired: 0,
      duplicate: 1,
    });

    let notification:
      | { title?: string; body?: string; threadId?: string | null }
      | undefined;
    await expect
      .poll(
        async () => {
          const response = await page.request.get("/api/notifications");
          const body = (await response.json()) as {
            notifications?: Array<{
              title?: string;
              body?: string;
              threadId?: string | null;
            }>;
          };
          notification = body.notifications?.find(
            (item) => item.title === "Auth Smoke Weekly Status finished",
          );
          return notification?.body ?? null;
        },
        { timeout: 20_000 },
      )
      .toContain("GitHub event");
    expect(notification?.threadId).toBeTruthy();

    await page.goto(`/chat?threadId=${notification!.threadId}`);
    await expect(
      page.getByText(
        "GitHub event: pull request review in dadjokez/ai-workspace",
      ),
    ).toBeVisible({ timeout: 15_000 });

    await page.goto(`/skills/${skillId}`);
    const activeRow = page.locator("li").filter({
      hasText: "dadjokez/ai-workspace",
    });
    await activeRow.getByRole("button", { name: "Pause" }).click();
    await expect(activeRow).toContainText("paused");
    const pausedResponse = await sendWebhook();
    expect(pausedResponse.status()).toBe(202);
    expect(await pausedResponse.json()).toMatchObject({ matched: 0, fired: 0 });

    await activeRow.getByRole("button", { name: "Resume" }).click();
    await expect(activeRow).not.toContainText("paused");

    const deleteRoute = "**/api/event-triggers/*";
    await page.route(deleteRoute, async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary delete failure." }),
      });
    });
    await activeRow.getByRole("button", { name: "Delete" }).click();
    const deleteDialog = page.getByRole("alertdialog", {
      name: "Delete trigger?",
    });
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole("button", { name: "Delete" }).click();
    await expect(deleteDialog.getByRole("alert")).toContainText(
      "Temporary delete failure.",
    );

    await page.unroute(deleteRoute);
    const [deleteResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes("/api/event-triggers/") &&
          response.request().method() === "DELETE",
      ),
      deleteDialog.getByRole("button", { name: "Delete" }).click(),
    ]);
    expect(deleteResponse.ok()).toBe(true);
    await expect(activeRow).toHaveCount(0);
    const deletedResponse = await sendWebhook();
    expect(deletedResponse.status()).toBe(202);
    expect(await deletedResponse.json()).toMatchObject({ matched: 0, fired: 0 });
  });

  test("sends, retries, and revokes admin invitations", async ({ page }) => {
    const email = `alpha-${Date.now()}@example.com`;

    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Invitations", exact: true }),
    ).toBeVisible();

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Invite role").selectOption("admin");
    const [sendResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/admin/invitations") &&
          response.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Send invite" }).click(),
    ]);
    expect(sendResponse.status()).toBe(201);

    const row = page.locator("tr").filter({ hasText: email });
    await expect(row).toContainText("failed");
    await expect(row).toContainText("email is not configured");
    await expect(row.getByRole("button", { name: "Resend" })).toBeEnabled();
    await expect(row.getByRole("button", { name: "Revoke" })).toBeEnabled();

    const [resendResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes(`/api/admin/invitations/`) &&
          response.url().endsWith("/resend") &&
          response.request().method() === "POST",
      ),
      row.getByRole("button", { name: "Resend" }).click(),
    ]);
    expect(resendResponse.ok()).toBe(true);
    await expect(row).toContainText("failed");

    const [revokeResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes(`/api/admin/invitations/`) &&
          response.url().endsWith("/revoke") &&
          response.request().method() === "POST",
      ),
      row.getByRole("button", { name: "Revoke" }).click(),
    ]);
    expect(revokeResponse.ok()).toBe(true);
    await expect(row).toContainText("revoked");
    await expect(row.getByRole("button", { name: "Resend" })).toBeDisabled();
  });

  test("keeps admin feedback rows in sync with URL filters", async ({
    page,
  }) => {
    await page.goto("/admin/feedback");
    await expect(page.getByText("No feedback in this view")).toBeVisible();

    await page.getByRole("link", { name: "All (3)" }).click();
    await expect(page).toHaveURL(/\/admin\/feedback\?status=all$/);
    await expect(page.getByText("showing 3 reports")).toBeVisible();
    const table = page.getByRole("table");
    await expect(table.getByText("Auth Smoke Triaged Feedback")).toBeVisible();
    await expect(table.getByText("Auth Smoke Fixed Feedback")).toBeVisible();
    await expect(
      table.getByText("Auth Smoke Legacy Resolved Feedback"),
    ).toBeVisible();

    const legacyRow = table.getByRole("row").filter({
      hasText: "Auth Smoke Legacy Resolved Feedback",
    });
    await legacyRow.getByText("Triage notes").click();
    await legacyRow
      .getByPlaceholder("Admin notes")
      .fill("Legacy status remains canonical after this notes-only edit.");
    const [notesResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes("/api/admin/feedback/") &&
          response.request().method() === "PATCH",
      ),
      legacyRow.getByRole("button", { name: "Save notes" }).click(),
    ]);
    expect(notesResponse.ok()).toBe(true);
    await expect(legacyRow.locator("select")).toHaveValue("fixed");

    await page.getByRole("link", { name: "Fixed (2)" }).click();
    await expect(page).toHaveURL(/\/admin\/feedback\?status=fixed$/);
    await expect(page.getByText("showing 2 reports")).toBeVisible();
    await expect(table.getByText("Auth Smoke Fixed Feedback")).toBeVisible();
    await expect(
      table.getByText("Auth Smoke Legacy Resolved Feedback"),
    ).toBeVisible();
    await expect(table.getByText("Auth Smoke Triaged Feedback")).toHaveCount(0);

    await page.goBack();
    await expect(page.getByText("showing 3 reports")).toBeVisible();
    await expect(table.getByText("Auth Smoke Triaged Feedback")).toBeVisible();
    await page.goForward();
    await expect(page.getByText("showing 2 reports")).toBeVisible();

    await page.goto("/admin/feedback?status=all");
    await expect(page.getByText("showing 3 reports")).toBeVisible();
  });

  test("shows a retryable error when feedback loading fails", async ({
    page,
  }) => {
    const db = getDb();
    await db.execute(
      sql`alter table feedback_reports rename to feedback_reports_unavailable`,
    );
    try {
      await page.goto("/admin/feedback?status=all");
      await expect(
        page.getByRole("heading", { name: "Feedback could not be loaded" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    } finally {
      await db.execute(
        sql`alter table feedback_reports_unavailable rename to feedback_reports`,
      );
    }

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("showing 3 reports")).toBeVisible();
  });

  test("opens the global command palette across protected surfaces", async ({
    page,
  }) => {
    for (const path of ["/skills", "/apps", "/admin"]) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path.replace("/", "\\/")}$`));
      const palette = await openCommandPalette(page);
      await expect(palette.getByRole("combobox")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(palette).toHaveCount(0);
    }

    const palette = await openCommandPalette(page);
    await palette.getByRole("combobox").fill("Usage");
    await palette.getByRole("option", { name: /Usage/ }).click();
    await expect(page).toHaveURL(/\/admin\/usage$/);
  });
});

async function openCommandPalette(page: Page) {
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(async () => {
    await page.keyboard.press("Control+K");
    await expect(palette).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  return palette;
}

test.describe("magic-link sign-in request (logged out)", () => {
  // No session cookie installed: these drive the real request-phase pipeline
  // (csrf → signin/email → invite gate → adapter token write). SES stays
  // disabled in this environment, so the allowed path no-ops the actual send
  // (the link is logged server-side) — no email ever leaves the suite.

  test("existing tester email gets the neutral link-sent state", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Email address").fill(authSmokeUser.email);
    await page
      .getByRole("button", { name: "Email me a sign-in link" })
      .click();
    await expect(
      page.getByText(/if that address is invited, a sign-in link is on its way/i),
    ).toBeVisible();
  });

  test("stranger email gets the SAME neutral state — no account-existence oracle", async ({
    page,
  }) => {
    await page.goto("/login");
    await page
      .getByLabel("Email address")
      .fill("definitely-not-invited-e2e@example.com");
    await page
      .getByRole("button", { name: "Email me a sign-in link" })
      .click();
    await expect(
      page.getByText(/if that address is invited, a sign-in link is on its way/i),
    ).toBeVisible();
  });
});
