import { expect, test, type Locator } from "@playwright/test";
import {
  assistantMessage,
  defaultArtifactDetail,
  defaultArtifactSummary,
  installMockComparativeApi,
  json,
  now,
  userMessage,
} from "./helpers/mock-comparative";
import { gotoE2EChat, openPrimarySidebar } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked Contribution Studio tests run only against the local e2e harness",
);

const threadId = "thread-contribution-studio";
const runId = "00000000-0000-4000-8000-000000000740";
const foreignArtifact = {
  ...defaultArtifactSummary,
  id: "artifact-other-thread",
  title: "Other thread file",
  filename: "other-thread.md",
  kind: "markdown",
  mimeType: "text/markdown",
  threadId: "thread-other",
  artifactGroupId: "other-thread-file",
  previewUrl: "/api/workspace/artifacts/artifact-other-thread/preview",
  downloadUrl: "/api/workspace/artifacts/artifact-other-thread/download",
};

test.describe("Contribution Studio", () => {
  test("derives scoped tabs, evidence, and the Live Work Map without exposing private reasoning", async ({
    page,
    isMobile,
  }) => {
    let browserStartBody: Record<string, unknown> | undefined;
    const browserActions: Array<Record<string, unknown>> = [];
    const stoppedBrowserSessions: string[] = [];
    await installMockComparativeApi(page, {
      runtimeCapabilities: { studioBrowser: true },
      onStudioBrowserStart: async (body, route) => {
        browserStartBody = body;
        const target = body.target as { sourceNumber?: number } | undefined;
        if (target?.sourceNumber === 3) {
          await json(
            route,
            {
              error: "browser_target_blocked",
              message: "This site is blocked by the workspace web policy.",
            },
            403,
          );
          return;
        }
        await json(route, {
          session: {
            id: "00000000-0000-4000-8000-000000000741",
            threadId,
            status: "ready",
            targetKind: "public",
            displayUrl: "https://example.com/evidence",
            origin: "https://example.com",
            expiresAt: "2026-08-10T12:15:00.000Z",
            viewport: { width: 1440, height: 900 },
            fallback: {
              title: "Live Browser unavailable",
              detail: "Use the persisted source receipt.",
            },
          },
        }, 201);
      },
      onStudioBrowserAction: async (sessionId, body, route) => {
        browserActions.push({ sessionId, ...body });
        await json(route, { ok: true });
      },
      onStudioBrowserScreenshot: async (_sessionId, route) => {
        await route.fulfill({
          status: 200,
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64",
          ),
        });
      },
      onStudioBrowserStop: async (sessionId, route) => {
        stoppedBrowserSessions.push(sessionId);
        await route.fulfill({ status: 204, body: "" });
      },
      threads: [
        {
          id: threadId,
          title: "Studio verification",
          defaultModelId: "sonnet-4-5",
          summary: null,
          summaryUpdatedAt: null,
          previewSummary: null,
          previewSummaryUpdatedAt: null,
          titleSource: "generated",
          createdAt: now,
          updatedAt: now,
        },
      ],
      artifacts: [defaultArtifactSummary, foreignArtifact],
      artifactDetails: {
        [defaultArtifactSummary.id]: defaultArtifactDetail,
      },
      threadMessages: {
        [threadId]: [
          userMessage({
            id: "studio-user",
            content: "Research this and make a brief.",
          }),
          assistantMessage({
            id: "studio-assistant",
            content: "The brief is ready.",
            runId,
            artifacts: [defaultArtifactSummary],
            providerReasoning: [
              {
                iteration: 1,
                blockIndex: 0,
                text: "private chain of thought",
                redacted: false,
              },
            ],
            sources: [
              {
                n: 1,
                title: "Public evidence",
                kind: "web",
                url: "https://example.com/evidence",
                toolCallId: "search-1",
              },
              {
                n: 2,
                title: "Blocked scheme",
                kind: "web",
                url: "javascript:alert(1)",
                toolCallId: "search-2",
              },
              {
                n: 3,
                title: "Denied evidence",
                kind: "web",
                url: "https://blocked.example/private",
                toolCallId: "search-3",
              },
            ],
            activityEvents: [
              {
                id: "plan-1",
                state: "pending",
                label: "Queued research",
                category: "progress",
                at: "2026-06-14T19:59:55.000Z",
              },
              {
                id: "search-1",
                state: "pending",
                label: "Searching public evidence",
                category: "tools",
                at: "2026-06-14T19:59:56.000Z",
              },
              {
                id: "approval-1",
                state: "pending",
                label: "Waiting for approval",
                category: "tools",
                at: "2026-06-14T19:59:57.000Z",
              },
              {
                id: "crm-1",
                state: "failed",
                label: "Could not query CRM",
                category: "tools",
                at: "2026-06-14T19:59:58.000Z",
              },
              {
                id: "cancel-1",
                state: "succeeded",
                label: "Run canceled",
                category: "progress",
                at: "2026-06-14T19:59:59.000Z",
              },
              {
                id: "created-1",
                state: "succeeded",
                label: "Created brief",
                category: "workspace",
                at: now,
              },
            ],
          }),
        ],
      },
    });

    await gotoE2EChat(page);
    const sidebar = await openPrimarySidebar(page, isMobile);
    await sidebar.getByRole("button", { name: "Studio verification" }).click();

    await page.getByRole("button", { name: "Show Contribution Studio" }).click();
    const studio = page.getByRole("complementary", {
      name: "Contribution Studio",
    });
    await expect(studio).toBeVisible();
    const studioMark = studio.getByTestId("contribution-studio-mark");
    await expectCanonicalStudioMark(studioMark);
    await expect(studio.getByRole("button", { name: "Preview" })).toBeVisible();
    await expect(studio.getByRole("button", { name: "Files" })).toBeVisible();
    await expect(studio.getByRole("button", { name: "Browser" })).toBeVisible();
    await expect(studio.getByRole("button", { name: "Activity" })).toBeVisible();
    await expect(studio.getByRole("button", { name: "Console" })).toHaveCount(0);

    await studio.getByRole("button", { name: "Files" }).click();
    await expect(studio.getByText("demo-artifact.html")).toBeVisible();
    await expect(studio.getByText("other-thread.md")).toHaveCount(0);

    await studio.getByRole("button", { name: "Browser" }).click();
    await expect(
      studio.getByRole("button", { name: /Public evidence/ }),
    ).toBeVisible();
    await expect(studio.getByText("Blocked scheme")).toHaveCount(0);

    await studio.getByRole("button", { name: "Activity" }).click();
    const workMap = page.getByTestId("studio-work-map");
    for (const state of ["planned", "active", "waiting", "failed", "canceled"]) {
      await expect(workMap.locator(`[data-state="${state}"]`)).toHaveCount(1);
    }
    await expect(studio.getByText("Created brief")).not.toBeVisible();
    await expect(studio.getByText(/Completed details/)).toBeVisible();
    await expect(studio.getByText("private chain of thought")).toHaveCount(0);
    await expect(
      studio.getByRole("button", { name: "Inspect run" }).first(),
    ).toBeVisible();

    if (!isMobile) {
      const chat = page.getByTestId("chat-workspace-pane");
      const before = await studio.boundingBox();
      await studio.getByRole("button", { name: "Maximize Studio" }).click();
      const after = await studio.boundingBox();
      const chatBox = await chat.boundingBox();
      expect(before).toBeTruthy();
      expect(after).toBeTruthy();
      expect(chatBox).toBeTruthy();
      expect(after!.width).toBeGreaterThan(before!.width);
      expect(chatBox!.width).toBeGreaterThanOrEqual(400);
      expect(chatBox!.x + chatBox!.width).toBeLessThanOrEqual(after!.x + 1);
      await expectCanonicalStudioMark(studioMark);
      const resizer = page.getByTestId("contribution-studio-resizer");
      await resizer.press("Shift+ArrowRight");
      const resized = await studio.boundingBox();
      expect(resized).toBeTruthy();
      expect(resized!.width).toBeLessThan(after!.width - 60);
      await expectCanonicalStudioMark(studioMark);
      for (let step = 0; step < 10; step += 1) {
        await resizer.press("Shift+ArrowRight");
      }
      await expect(resizer).toHaveAttribute("aria-valuenow", "380");
      await expectCanonicalStudioMark(studioMark);
      await expect(
        studio.getByRole("button", { name: "Maximize Studio" }),
      ).toBeVisible();
    }

    await studio
      .getByRole("button", { name: "Close Contribution Studio" })
      .click();

    await page.getByTestId("source-chip-1").click();
    await expect(studio).toBeVisible();
    await expect(studio.getByTestId("studio-browser-location")).toHaveText(
      "https://example.com/evidence",
    );
    await expect(studio.getByText("Live Browser unavailable")).toBeVisible();
    await studio.getByRole("button", { name: "Show snapshot" }).click();
    const snapshot = studio.getByTestId("studio-browser-snapshot");
    await expect(snapshot).toBeVisible();
    await expect
      .poll(() =>
        snapshot.evaluate((element) =>
          (element as HTMLImageElement).naturalWidth,
        ),
      )
      .toBeGreaterThan(0);
    expect(browserStartBody).toEqual({
      threadId,
      target: {
        kind: "evidence",
        messageId: "studio-assistant",
        sourceNumber: 1,
      },
    });

    for (const [label] of [
      ["Back", "back"],
      ["Forward", "forward"],
      ["Reload", "reload"],
    ] as const) {
      await studio.getByRole("button", { name: label, exact: true }).click();
    }
    expect(browserActions).toEqual(
      ["back", "forward", "reload"].map((action) => ({
        sessionId: "00000000-0000-4000-8000-000000000741",
        action,
      })),
    );

    await studio.getByRole("button", { name: "Browser targets" }).click();
    await expect(studio.getByText("Browser targets", { exact: true })).toBeVisible();
    await expect.poll(() => stoppedBrowserSessions).toEqual([
      "00000000-0000-4000-8000-000000000741",
    ]);
    await studio.getByRole("button", { name: /Denied evidence/ }).click();
    await expect(studio.getByRole("alert")).toHaveText(
      "This site is blocked by the workspace web policy.",
    );
    await studio
      .getByRole("button", { name: "Close Contribution Studio" })
      .click();

    await page.getByRole("button", { name: "Show Contribution Studio" }).click();
    await expect(
      page.getByRole("button", { name: "Activity" }),
    ).toHaveAttribute("aria-current", "page");
  });
});

async function expectCanonicalStudioMark(mark: Locator) {
  await expect(mark).toBeVisible();
  await expect
    .poll(() =>
      mark.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          height: Math.round(bounds.height),
          width: Math.round(bounds.width),
        };
      }),
    )
    .toEqual({ height: 24, width: 24 });
  await expect(mark).toHaveCSS("flex-shrink", "0");
}
