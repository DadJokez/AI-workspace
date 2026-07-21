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
  "skin defaults are exercised against the local harness only",
);

// The default mechanism is subtle: the pre-paint script applies skin-umber
// for the first frame, then React 19 hydration replaces <html>'s className and
// UiSkinSync must re-assert it. Classic remains an explicit escape hatch.
test("Umber defaults on, survives hydration, and retains the Classic escape hatch", async ({
  page,
}) => {
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.removeItem("ui-skin");
    localStorage.setItem("theme", "light");
  });
  await page.reload();
  await page.waitForLoadState("networkidle");

  await expect(page.locator("html")).toHaveClass(/skin-umber/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const canvas = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "rgb(from var(--color-canvas) r g b)";
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect(page.locator("body")).toHaveCSS("background-color", canvas);

  await page.evaluate(() => localStorage.setItem("theme", "dark"));
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveClass(/skin-umber/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.evaluate(() => localStorage.setItem("ui-skin", "classic"));
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("html")).not.toHaveClass(/skin-umber/);
});

// The class flip alone can't prove the chat chrome reskinned — a surface
// whose container kept hardcoded navy hex passes the tests above (that
// half-reskin shipped once: dots went forest while cards stayed
// electric-blue). This pins computed styles: reskinned cards must resolve
// to the Umber tokens, and the pre-Umber navy must be gone.
test("chat chrome uses Umber surfaces by default in both themes", async ({
  page,
  isMobile,
}) => {
  await installMockComparativeApi(page, {
    artifacts: [],
    skills: [
      {
        id: "skill-umber-check",
        slug: "umber-check",
        name: "Umber Check",
        description: "Fixture skill for the composer pill.",
        mcpProviders: [],
        isStarter: true,
        sharedWithMe: false,
      },
    ],
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
    localStorage.removeItem("ui-skin");
    localStorage.setItem("theme", "light");
  });
  await page.reload();
  const sidebar = await openPrimarySidebar(page, isMobile);
  await sidebar.getByRole("button", { name: /umber chrome check/i }).click();
  await expect(page.locator("html")).toHaveClass(/skin-umber/);

  const tokens = await page.evaluate(() => {
    const resolveColor = (slot: string) => {
      const probe = document.createElement("span");
      probe.style.color = `rgb(from var(${slot}) r g b)`;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    return {
      surface: resolveColor("--color-surface"),
      subtle: resolveColor("--color-subtle"),
      accent: resolveColor("--color-accent"),
      ink: resolveColor("--color-ink"),
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

  // The composer's active-slash-skill pill: cream surface AND ink text —
  // the surface flipping without the text is the low-contrast half-reskin
  // a class-flip test can't see.
  await page.getByPlaceholder(/ask anything/i).fill("/umber");
  await page
    .getByRole("button", { name: /Umber Check Fixture skill/i })
    .click();
  const skillPill = page.getByTestId("active-slash-skill");
  await expect(skillPill).toContainText("/umber-check");
  await expect(skillPill).toHaveCSS("background-color", tokens.subtle);
  await expect(skillPill).toHaveCSS("color", tokens.ink);

  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.dataset.theme = "dark";
  });
  const darkTokens = await page.evaluate(() => {
    const resolveColor = (slot: string) => {
      const probe = document.createElement("span");
      probe.style.color = `rgb(from var(${slot}) r g b)`;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    return {
      surface: resolveColor("--color-surface"),
      subtle: resolveColor("--color-subtle"),
      accent: resolveColor("--color-accent"),
      ink: resolveColor("--color-ink"),
    };
  });
  await expect(card).toHaveCSS("background-color", darkTokens.surface);
  await expect(codePreview).toHaveCSS("background-color", darkTokens.subtle);
  await expect(pill).toHaveCSS("background-color", darkTokens.accent);
  await expect(skillPill).toHaveCSS("background-color", darkTokens.subtle);
  await expect(skillPill).toHaveCSS("color", darkTokens.ink);
});

test("the Settings skin control exposes Classic as an escape hatch", async ({
  page,
  isMobile,
}) => {
  await installMockComparativeApi(page);
  await gotoE2EChat(page);
  await openNavItem(page, "Settings", isMobile);

  await expect(
    page.getByRole("radio", { name: "Umber", exact: true }),
  ).toBeChecked();
  await expect(page.locator("html")).toHaveClass(/skin-umber/);

  await page.getByRole("radio", { name: "Classic", exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/skin-umber/);

  await page.getByRole("radio", { name: "Umber", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/skin-umber/);
});
