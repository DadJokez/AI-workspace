import { expect, test } from "@playwright/test";
import {
  defaultArtifactSummary,
  fulfillSse,
  installMockComparativeApi,
} from "./helpers/mock-comparative";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "mocked citation tests run only against the local e2e harness",
);

test("renders persisted source chips without inventing inline attribution", async ({
  page,
}) => {
  const hostileTitle = '<img src=x onerror="globalThis.pwned=true">';
  const pullRequestUrl =
    "https://github.com/DadJokez/AI-workspace/pull/542";

  await installMockComparativeApi(page, {
    onChat: async (_body, route) => {
      await fulfillSse(route, [
        {
          type: "meta",
          threadId: "thread-citations",
          modelId: "sonnet-4-6",
        },
        {
          type: "tool-call",
          call: {
            id: "github-pr",
            name: "mcp__github__get_pull_request",
            input: {
              owner: "DadJokez",
              repo: "AI-workspace",
              pullNumber: 542,
            },
          },
        },
        {
          type: "tool-result",
          result: {
            toolCallId: "github-pr",
            output: { title: hostileTitle, html_url: pullRequestUrl },
            isError: false,
          },
        },
        {
          type: "text-delta",
          delta:
            "The attribution change is ready for review [1]. Unknown source [3].",
        },
        {
          type: "persisted",
          assistantMessageId: "assistant-citations",
          artifacts: [defaultArtifactSummary],
          recommendations: [],
          sources: [
            {
              n: 1,
              title: hostileTitle,
              url: pullRequestUrl,
              kind: "repo",
              toolCallId: "github-pr",
            },
            {
              n: 2,
              title: defaultArtifactSummary.filename,
              url: defaultArtifactSummary.previewUrl,
              kind: "artifact",
            },
          ],
        },
        { type: "done", stopReason: "completed" },
      ]);
    },
  });

  await page.goto("/e2e/chat");
  await page
    .getByPlaceholder(/ask anything/i)
    .fill("Check the attribution pull request.");
  await page.getByRole("button", { name: "Send" }).click();

  const sources = page.getByTestId("message-sources");
  await expect(sources).toBeVisible();
  await expect(sources.locator("img")).toHaveCount(0);
  await expect(sources).toContainText(hostileTitle);
  await expect(sources).toContainText("Sources consulted");
  await expect(sources).not.toContainText("[1]");
  await expect(sources).not.toContainText("[2]");

  const repoChip = page.getByTestId("source-chip-1");
  await expect(repoChip).toHaveAttribute("href", pullRequestUrl);
  await expect(repoChip).toHaveAttribute("target", "_blank");
  await expect(repoChip).toHaveAttribute("rel", "noreferrer");

  await expect(page.locator('a[href^="#source-"]')).toHaveCount(0);
  await expect(
    page.getByText("The attribution change is ready for review [1]."),
  ).toBeVisible();
  await expect(page.getByText("Unknown source [3].")).toBeVisible();

  await page.getByTestId("source-chip-2").click();
  const preview = page.getByRole("complementary", {
    name: "Artifact preview",
  });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(defaultArtifactSummary.filename);
});
