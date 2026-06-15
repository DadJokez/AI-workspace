import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  assistantMessage,
  defaultArtifactSummary,
  fulfillSse,
  installMockComparativeApi,
  json,
  userMessage,
} from "./helpers/mock-comparative";
import { gotoE2EChat } from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked chat workflow tests run only against the local e2e harness",
);

test.describe("chat workflow regressions", () => {
  test("downloads the active chat as markdown", async ({ page }) => {
    await installMockComparativeApi(page, {
      onChat: async (_body, route) => {
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-export",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta:
              "Exportable answer with enough detail for a transcript and artifact.",
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-export",
            artifacts: [defaultArtifactSummary],
            recommendations: [],
          },
          { type: "done" },
        ]);
      },
    });

    await gotoE2EChat(page);
    await page
      .getByPlaceholder(/ask anything/i)
      .fill("Please make this exportable.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText(
        "Exportable answer with enough detail for a transcript and artifact.",
      ),
    ).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download chat transcript" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/please-make-this-exportable/i);
    expect(download.suggestedFilename()).toMatch(/\.md$/);

    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const transcript = await readFile(downloadPath!, "utf8");
    expect(transcript).toContain("# Please make this exportable.");
    expect(transcript).toContain("Please make this exportable.");
    expect(transcript).toContain(
      "Exportable answer with enough detail for a transcript and artifact.",
    );
    expect(transcript).toContain("- Thread ID: thread-export");
    expect(transcript).toContain("### Artifacts");
    expect(transcript).toContain("demo-artifact.html (html, 1.3 KB)");
  });

  test("keeps messages isolated across chat tabs", async ({ page }) => {
    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (body, route) => {
        const message = String(body.message ?? "");
        const isAlpha = message.includes("alpha");
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: isAlpha ? "thread-alpha" : "thread-beta",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: isAlpha
              ? "Alpha tab answer only."
              : "Beta tab answer only.",
          },
          {
            type: "persisted",
            assistantMessageId: isAlpha ? "assistant-alpha" : "assistant-beta",
            artifacts: [],
            recommendations: [],
          },
          { type: "done" },
        ]);
      },
    });

    await gotoE2EChat(page);
    await page.getByPlaceholder(/ask anything/i).fill("alpha tab question");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Alpha tab answer only.")).toBeVisible();

    await page.getByRole("button", { name: "New tab" }).click();
    await page.getByPlaceholder(/ask anything/i).fill("beta tab question");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Beta tab answer only.")).toBeVisible();

    await page
      .getByRole("button", { name: /alpha tab question/i })
      .first()
      .click();
    const main = page.locator("main");
    await expect(main.getByText("Alpha tab answer only.")).toBeVisible();
    await expect(main.getByText("Beta tab answer only.")).toHaveCount(0);

    await page
      .getByRole("button", { name: /beta tab question/i })
      .first()
      .click();
    await expect(main.getByText("Beta tab answer only.")).toBeVisible();
    await expect(main.getByText("Alpha tab answer only.")).toHaveCount(0);
  });

  test("keeps tab state stable while another tab is busy", async ({ page }) => {
    const chatBodies: Array<Record<string, unknown>> = [];
    let releaseSlowResponse: (() => void) | undefined;
    const slowResponseGate = new Promise<void>((resolve) => {
      releaseSlowResponse = resolve;
    });

    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (body, route) => {
        chatBodies.push(body);
        const message = String(body.message ?? "");
        const isSlow =
          message === "slow tab question" ||
          message === "slow follow up" ||
          body.threadId === "thread-slow";
        const isFollowUp = message.includes("follow up");
        if (message === "slow tab question") {
          await slowResponseGate;
        }

        await fulfillSse(route, [
          {
            type: "meta",
            threadId: isSlow ? "thread-slow" : "thread-fast",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: isSlow
              ? isFollowUp
                ? "Slow follow-up answer."
                : "Slow tab answer."
              : isFollowUp
                ? "Fast follow-up answer."
                : "Fast tab answer.",
          },
          {
            type: "persisted",
            assistantMessageId: `assistant-${chatBodies.length}`,
            artifacts: [],
            recommendations: [],
          },
          { type: "done" },
        ]);
      },
    });

    await gotoE2EChat(page);
    const header = page.locator("header").first();

    await page.getByPlaceholder(/ask anything/i).fill("slow tab question");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByPlaceholder("Generating…")).toBeVisible();
    await expect(header.locator(".animate-pulse")).toHaveCount(1);

    await header.getByRole("button", { name: "New tab" }).click();
    await expect(page.getByPlaceholder(/ask anything/i)).toBeEnabled();
    await page.getByPlaceholder(/ask anything/i).fill("fast tab question");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Fast tab answer.")).toBeVisible();
    await expect(
      header.getByRole("button", { name: /fast tab question/i }),
    ).toBeVisible();

    await page.getByPlaceholder(/ask anything/i).fill("fast follow up");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Fast follow-up answer.")).toBeVisible();
    await expect(
      header.getByRole("button", { name: /fast tab question/i }),
    ).toBeVisible();
    await expect(
      header.getByRole("button", { name: /fast follow up/i }),
    ).toHaveCount(0);

    await header
      .getByRole("button", { name: /slow tab question/i })
      .first()
      .click();
    await expect(page.getByPlaceholder("Generating…")).toBeVisible();
    releaseSlowResponse?.();
    await expect(page.getByText("Slow tab answer.")).toBeVisible();
    await expect(header.locator(".animate-pulse")).toHaveCount(0);

    await page.getByPlaceholder(/ask anything/i).fill("slow follow up");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Slow follow-up answer.")).toBeVisible();

    expect(chatBodies.map((body) => body.message)).toEqual([
      "slow tab question",
      "fast tab question",
      "fast follow up",
      "slow follow up",
    ]);
    expect(chatBodies[0]?.threadId).toBeUndefined();
    expect(chatBodies[1]?.threadId).toBeUndefined();
    expect(chatBodies[2]?.threadId).toBe("thread-fast");
    expect(chatBodies[3]?.threadId).toBe("thread-slow");
  });

  test("restores persisted chat tabs after reload", async ({ page }) => {
    await installMockComparativeApi(page, {
      artifacts: [],
      threadMessages: {
        "thread-persist-alpha": [
          userMessage({
            id: "user-persist-alpha",
            content: "alpha reload tab",
          }),
          assistantMessage({
            id: "assistant-persist-alpha",
            content: "Alpha persisted answer.",
          }),
        ],
        "thread-persist-beta": [
          userMessage({
            id: "user-persist-beta",
            content: "beta reload tab",
          }),
          assistantMessage({
            id: "assistant-persist-beta",
            content: "Beta persisted answer.",
          }),
          userMessage({
            id: "user-persist-beta-second",
            content: "beta second message",
          }),
          assistantMessage({
            id: "assistant-persist-beta-second",
            content: "Beta second persisted answer.",
          }),
        ],
      },
      onChat: async (body, route) => {
        const message = String(body.message ?? "");
        const isAlpha = message.includes("alpha");
        const isSecond = message.includes("second");
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: isAlpha
              ? "thread-persist-alpha"
              : "thread-persist-beta",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: isAlpha
              ? "Alpha persisted answer."
              : isSecond
                ? "Beta second persisted answer."
              : "Beta persisted answer.",
          },
          {
            type: "persisted",
            assistantMessageId: isAlpha
              ? "assistant-persist-alpha"
              : isSecond
                ? "assistant-persist-beta-second"
              : "assistant-persist-beta",
            artifacts: [],
            recommendations: [],
          },
          { type: "done" },
        ]);
      },
    });

    await gotoE2EChat(page);
    const header = page.locator("header").first();

    await page.getByPlaceholder(/ask anything/i).fill("alpha reload tab");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Alpha persisted answer.")).toBeVisible();

    await header.getByRole("button", { name: "New tab" }).click();
    await page.getByPlaceholder(/ask anything/i).fill("beta reload tab");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Beta persisted answer.")).toBeVisible();

    await page.getByPlaceholder(/ask anything/i).fill("beta second message");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Beta second persisted answer.")).toBeVisible();
    await expect(
      header.getByRole("button", { name: /beta reload tab/i }),
    ).toBeVisible();
    await expect(
      header.getByRole("button", { name: /beta second message/i }),
    ).toHaveCount(0);

    await page.reload();
    await expect(
      header.getByRole("button", { name: /alpha reload tab/i }),
    ).toBeVisible();
    await expect(
      header.getByRole("button", { name: /beta reload tab/i }),
    ).toBeVisible();
    await expect(page.getByText("Beta persisted answer.")).toBeVisible();
    await expect(page.getByText("Beta second persisted answer.")).toBeVisible();
    await expect(page.getByText("Alpha persisted answer.")).toHaveCount(0);

    await header
      .getByRole("button", { name: /alpha reload tab/i })
      .first()
      .click();
    await expect(page.getByText("Alpha persisted answer.")).toBeVisible();
    await expect(page.getByText("Beta persisted answer.")).toHaveCount(0);
  });

  test("surfaces chat errors and retries the failed prompt", async ({ page }) => {
    let attempts = 0;
    await installMockComparativeApi(page, {
      artifacts: [],
      onChat: async (_body, route) => {
        attempts += 1;
        if (attempts === 1) {
          await json(route, { error: "temporary bedrock failure" }, 500);
          return;
        }
        await fulfillSse(route, [
          {
            type: "meta",
            threadId: "thread-retry",
            modelId: "sonnet-4-6",
          },
          {
            type: "text-delta",
            delta: "Retried successfully.",
          },
          {
            type: "persisted",
            assistantMessageId: "assistant-retry",
            artifacts: [],
            recommendations: [],
          },
          { type: "done" },
        ]);
      },
    });

    await gotoE2EChat(page);
    await page.getByPlaceholder(/ask anything/i).fill("retry this prompt");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Error", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("Retried successfully.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(
      0,
    );
    expect(attempts).toBe(2);
  });
});
