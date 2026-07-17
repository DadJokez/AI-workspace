import { expect, test } from "@playwright/test";
import {
  assistantMessage,
  defaultArtifactSummary,
  installMockComparativeApi,
  userMessage,
} from "./helpers/mock-comparative";
import {
  gotoE2EChat,
  openNavItem,
  openPrimarySidebar,
} from "./helpers/navigation";

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "skin opt-in is exercised against the local harness only",
);

// The opt-in mechanism is subtle: the pre-paint script applies skin-umber for
// the first frame, then React 19 hydration replaces <html>'s className and
// UiSkinSync must re-assert it. This locks the end state down — it fails if
// either half regresses (it did once: the class silently vanished after
// hydration before UiSkinSync existed).
test("ui-skin=umber survives hydration and remaps the palette", async ({
  page,
}) => {
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("ui-skin", "umber");
    localStorage.setItem("theme", "light");
  });
  await page.reload();
  await page.waitForLoadState("networkidle");

  await expect(page.locator("html")).toHaveClass(/skin-umber/);
  const canvas = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--color-canvas")
      .trim(),
  );
  expect(canvas).toBe("250 248 243"); // Umber --bg (neutral-50), not the default 247 246 243

  // And the default stays untouched without the opt-in.
  await page.evaluate(() => localStorage.removeItem("ui-skin"));
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("html")).not.toHaveClass(/skin-umber/);
});

// The class flip alone can't prove the chat chrome reskinned — a surface
// whose container kept hardcoded navy hex passes the tests above (that
// half-reskin shipped once: dots went forest while cards stayed
// electric-blue). This pins computed styles: reskinned cards must resolve
// to the Umber tokens, and the pre-Umber navy must be gone.
test("chat chrome cards resolve to Umber surfaces under skin-umber", async ({
  page,
  isMobile,
}) => {
  await installMockComparativeApi(page, {
    artifacts: [],
    threads: [
      {
        id: "thread-umber-chrome",
        title: "umber chrome check",
        defaultModelId: "sonnet-4-6",
        summary: null,
        summaryUpdatedAt: null,
        previewSummary: null,
        previewSummaryUpdatedAt: null,
        titleSource: "generated",
        createdAt: "2026-06-14T20:00:00.000Z",
        updatedAt: "2026-06-14T20:00:00.000Z",
      },
    ],
    threadMessages: {
      "thread-umber-chrome": [
        userMessage({ id: "user-umber-chrome", content: "make a page" }),
        assistantMessage({
          id: "assistant-umber-chrome",
          content: [
            "Here you go:",
            "",
            '```html filename="umber-check.html"',
            "<!doctype html><html><body>hi</body></html>",
            "```",
          ].join("\n"),
          artifacts: [
            {
              ...defaultArtifactSummary,
              id: "artifact-umber",
              threadId: "thread-umber-chrome",
              chatMessageId: "assistant-umber-chrome",
              runId: "run-umber-chrome",
            },
          ],
          recommendations: [
            {
              dbId: "recommendation-umber-chrome",
              id: "deploy-app:umber-check",
              type: "deploy_artifact_as_app",
              title: "Deploy this as an app",
              reason: "Looks reusable.",
              requiresApproval: true,
              action: { kind: "deploy_app", artifactId: "artifact-umber" },
              metadata: { artifactId: "artifact-umber" },
              status: "suggested",
              threadId: "thread-umber-chrome",
              chatMessageId: "assistant-umber-chrome",
              runId: "run-umber-chrome",
              createdAt: "2026-06-14T20:00:00.000Z",
            },
          ],
        }),
      ],
    },
  });

  await gotoE2EChat(page);
  await page.evaluate(() => {
    localStorage.setItem("ui-skin", "umber");
    localStorage.setItem("theme", "light");
  });
  await page.reload();
  const sidebar = await openPrimarySidebar(page, isMobile);
  await sidebar.getByRole("button", { name: /umber chrome check/i }).click();
  await expect(page.locator("html")).toHaveClass(/skin-umber/);

  const tokens = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    const toRgb = (slot: string) =>
      `rgb(${styles.getPropertyValue(slot).trim().split(/\s+/).join(", ")})`;
    return {
      surface: toRgb("--color-surface"),
      subtle: toRgb("--color-subtle"),
      accent: toRgb("--color-accent"),
    };
  });

  const card = page.getByTestId("recommendation-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveCSS("background-color", tokens.surface);

  const codePreview = page
    .locator("details")
    .filter({ hasText: "Document content collapsed" });
  await expect(codePreview).toBeVisible();
  await expect(codePreview).toHaveCSS("background-color", tokens.subtle);

  // The artifact pill drops its electric-blue gradient for the flat accent
  // CTA — background-image gone, background-color on-token.
  const pill = page.getByTestId("artifact-pill").first();
  await expect(pill).toBeVisible();
  await expect(pill).toHaveCSS("background-image", "none");
  await expect(pill).toHaveCSS("background-color", tokens.accent);
});

test("the Settings skin control flips Umber on and off live", async ({
  page,
  isMobile,
}) => {
  await installMockComparativeApi(page);
  await gotoE2EChat(page);
  await openNavItem(page, "Settings", isMobile);

  await page.getByRole("radio", { name: "Umber", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/skin-umber/);

  await page.getByRole("radio", { name: "Classic", exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/skin-umber/);
});
