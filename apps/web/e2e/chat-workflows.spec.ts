import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  defaultArtifactSummary,
  fulfillSse,
  installMockComparativeApi,
  json,
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
