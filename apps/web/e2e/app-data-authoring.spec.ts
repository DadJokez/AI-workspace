import { expect, test } from "@playwright/test";
import { assistantMessage, defaultArtifactSummary, fulfillSse, installMockComparativeApi, now } from "./helpers/mock-comparative";

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "authoring UI uses the local mocked chat harness");

const threadId = "thread-live-authoring";
const artifact = {
  ...defaultArtifactSummary, threadId,
  metadata: {
    dataBindings: [{ id: "data-1", provider: "github", toolName: "list_issues" }],
    connectedDataWarning: { kind: "possible_embedded_connected_data", providers: ["github"] },
  },
};
const content = `<!doctype html><html><head><title>Live issues</title></head><body>
<h1>Live issues</h1><div id="issues">Not published</div>
<script>
if (window.comparativeData) {
  window.comparativeData.refreshWidget('data-1', document.getElementById('issues'), data => JSON.stringify(data));
  fetch('/api/apps/should-not-run/data/private').catch(() => {});
}
</script></body></html>`;

for (const canAddress of [true, false]) {
  test(`unconnected preview makes no data requests; conversion permission=${canAddress}`, async ({ page, isMobile }, testInfo) => {
    let sent: Record<string, unknown> | undefined;
    const dataRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/apps\/.+\/data\//.test(request.url())) dataRequests.push(request.url());
    });
    await installMockComparativeApi(page, {
      threads: [{ id: threadId, title: "Live authoring", defaultModelId: "sonnet-4-5", summary: null, summaryUpdatedAt: null,
        previewSummary: null, previewSummaryUpdatedAt: null, titleSource: "generated", createdAt: now, updatedAt: now }],
      artifacts: [artifact], artifactDetails: { [artifact.id]: { ...artifact, content } },
      artifactReviewPermissions: { [artifact.id]: { canComment: true, canAddress } },
      threadMessages: { [threadId]: [assistantMessage({ id: "assistant-artifact", content: "File ready.", artifacts: [artifact] })] },
      onChat: async (body, route) => {
        sent = body;
        await fulfillSse(route, [
          { type: "meta", threadId, modelId: "sonnet-4-5" },
          { type: "text-delta", delta: "Conversion requested." },
          { type: "persisted", assistantMessageId: "converted", artifacts: [], recommendations: [] },
          { type: "done", stopReason: "completed" },
        ]);
      },
    });
    await page.goto(`/e2e/chat?threadId=${threadId}&artifactId=${artifact.id}`);
    const studio = page.getByRole("complementary", { name: "Contribution Studio" });
    await expect(studio).toContainText("may contain embedded GitHub data");
    const preview = studio.frameLocator("iframe");
    await expect(preview.locator("#issues")).toHaveText("Not published");
    await studio.getByRole("checkbox", { name: "Preview as unconnected viewer" }).check();
    await expect(preview.getByRole("link", { name: "Connect GitHub" })).toBeVisible();
    expect(dataRequests).toEqual([]);
    await expect(studio.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
    await studio.getByRole("checkbox", { name: "Preview as unconnected viewer" }).uncheck();
    await expect(preview.locator("#issues")).toHaveText("Not published");
    const button = studio.getByRole("button", { name: "Make live in chat" });
    if (canAddress) {
      const pages = page.context().pages().length;
      await button.click();
      await expect.poll(() => sent).toBeDefined();
      expect(sent?.threadId).toBe(threadId);
      expect(sent?.resourceReferences).toEqual([{ version: 1, kind: "artifact", resourceId: artifact.id }]);
      expect(page.context().pages()).toHaveLength(pages);
      if (isMobile) await expect(studio).toHaveCount(0);
    } else await expect(button).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("live-authoring.png"), fullPage: true });
  });
}
