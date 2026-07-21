import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
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
  test.describe.configure({ mode: "serial" });

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
          { type: "done" },
        ]);
      },
    });

    await page.goto("/chat");
    await expect(page.getByText("Talk to your work.")).toBeVisible();
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
    const recommendation = {
      dbId: "recommendation-auth-deploy",
      id: "deploy-app:artifact-demo-html",
      type: "deploy_artifact_as_app",
      title: "Deploy this as an app",
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
            threadId: "thread-generated",
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
          { type: "done" },
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
    await expect(page.getByText("Deploy this as an app")).toBeVisible();

    const previewBefore = page.context().pages().length;
    await page.getByRole("button", { name: /demo-artifact\.html/i }).click();
    await expect(
      page.getByRole("complementary", { name: "Artifact preview" }),
    ).toBeVisible();
    await expect(
      page
        .frameLocator('aside[aria-label="Artifact preview"] iframe')
        .getByRole("heading", { name: "Auth Smoke Artifact" }),
    ).toBeVisible();
    expect(page.context().pages()).toHaveLength(previewBefore);
    await page.getByRole("button", { name: "Close preview" }).click();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download chat transcript" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/build-a-signed-in/i);
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const transcript = await readFile(downloadPath!, "utf8");
    expect(transcript).toContain("Build a signed-in auth smoke HTML artifact.");
    expect(transcript).toContain("demo-artifact.html");

    if (isMobile) {
      await page.getByRole("button", { name: "Open menu" }).click();
    }
    await openNavItem(page, "Artifacts", isMobile);
    await expect(
      page.getByRole("heading", { level: 1, name: "Artifacts" }),
    ).toBeVisible();
    await expect(
      page.getByTestId("artifacts-pane").getByText(/demo-artifact\.html/),
    ).toBeVisible();

    await page.getByRole("button", { name: "Close workspace" }).click();
    await expect(page.getByText("Deploy this as an app")).toBeVisible();
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
          `Deploy navigation did not complete. Current URL: ${page.url()}. ${message}`,
        );
      });
    await page.getByRole("button", { name: "Deploy app" }).click();
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

    const draftRow = page.locator("li").filter({ hasText: "v3" });
    await expect(draftRow).toContainText("Draft");
    await draftRow.getByRole("button", { name: "Deploy" }).click();
    await expect(draftRow).toContainText("Live");

    const previousRow = page.locator("li").filter({ hasText: "v1" });
    await previousRow.getByRole("button", { name: "Rollback" }).click();
    await expect(previousRow).toContainText("Live");

    const throwawayRow = page.locator("li").filter({ hasText: "v4" });
    await expect(throwawayRow).toContainText("Draft");
    await throwawayRow.getByRole("button", { name: "Discard" }).click();
    await expect(throwawayRow).toHaveCount(0);

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
    page.once("dialog", (dialog) => dialog.accept());
    await activeRow.getByRole("button", { name: "Delete" }).click();
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
      page.getByRole("heading", { name: "Invitations" }),
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

  test("opens the global command palette across protected surfaces", async ({
    page,
  }) => {
    for (const path of ["/skills", "/apps", "/admin"]) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path.replace("/", "\\/")}$`));
      await page.keyboard.press("Control+K");
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await expect(palette).toBeVisible();
      await expect(palette.getByRole("combobox")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(palette).toHaveCount(0);
    }

    await page.keyboard.press("Control+K");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.getByRole("combobox").fill("Usage");
    await palette.getByRole("option", { name: /Usage/ }).click();
    await expect(page).toHaveURL(/\/admin\/usage$/);
  });
});

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
