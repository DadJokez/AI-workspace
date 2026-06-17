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
    await page.locator('input[type="file"]').setInputFiles(
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
    await expect(page.getByText("demo-artifact.html")).toBeVisible();

    await page.getByRole("button", { name: "Close workspace" }).click();
    await expect(page.getByText("Deploy this as an app")).toBeVisible();
    await page.getByRole("button", { name: "Deploy app" }).click();
    await expect(page).toHaveURL(
      /\/apps\/manage\/00000000-0000-4000-8000-000000000230$/,
    );
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

    await page.getByRole("button", { name: "Edit" }).click();
    await expect(page).toHaveURL(/\/chat\?threadId=/);
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
});
