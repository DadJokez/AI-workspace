import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Page } from "@playwright/test";
import {
  defaultArtifactDetail,
  defaultArtifactSummary,
  fulfillSse,
  installMockComparativeApi,
  now,
} from "../../../apps/web/e2e/helpers/mock-comparative";

const baseUrl = "http://127.0.0.1:3000";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const outDir = path.join(repoRoot, "tmp/pdfs/alpha-guide/screenshots");

const alphaSkills = [
  {
    id: "skill-weekly-status",
    slug: "weekly-status",
    name: "Weekly Status Writer",
    description: "Draft a concise weekly status update from notes.",
    prompt: "Write a user-facing status update.",
    mcpProviders: [],
    isStarter: true,
    sharedWithMe: false,
  },
  {
    id: "skill-launch-review",
    slug: "launch-review",
    name: "Launch Review",
    description: "Review launch notes and call out risks.",
    prompt: "Review launch notes for risks.",
    mcpProviders: ["github"],
    isStarter: false,
    sharedWithMe: true,
  },
];

const alphaThreads = [
  {
    id: "thread-weekly-update",
    title: "Weekly update draft",
    defaultModelId: "sonnet-4-6",
    summary: "Drafted a team update from notes and generated follow-ups.",
    summaryUpdatedAt: now,
    previewSummary: "Drafted a team update from notes and generated follow-ups.",
    previewSummaryUpdatedAt: now,
    titleSource: "user",
    createdAt: now,
    updatedAt: now,
  },
];

const artifactSummary = {
  ...defaultArtifactSummary,
  title: "Project Health Dashboard",
  filename: "project-health-dashboard.html",
};

const artifactDetail = {
  ...defaultArtifactDetail,
  ...artifactSummary,
  content:
    "<!doctype html><html><body><h1>Project Health Dashboard</h1><p>Milestones, risks, and next actions.</p></body></html>",
};

const recommendation = {
  dbId: "recommendation-alpha-deploy",
  id: "deploy-app:project-health-dashboard",
  type: "deploy_artifact_as_app",
  title: "Deploy this as an app",
  reason:
    "The generated dashboard looks reusable, so it can become a workspace app.",
  requiresApproval: true,
  action: { kind: "deploy_app", artifactId: artifactSummary.id },
  metadata: { artifactId: artifactSummary.id },
  status: "suggested",
  threadId: "thread-generated",
  chatMessageId: "assistant-generated",
  runId: "run-generated",
  createdAt: now,
  updatedAt: now,
};

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    await captureLogin(browser);
    await captureOnboarding(browser);
    await captureMainSurfaces(browser);
  } finally {
    await browser.close();
  }
  console.log(`screenshots saved to ${outDir}`);
}

async function newPage(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  await page.addInitScript(() => {
    window.localStorage.setItem("theme", "light");
  });
  return page;
}

async function captureLogin(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
) {
  const page = await newPage(browser);
  await page.goto(`${baseUrl}/login`);
  await expect(page.getByRole("heading", { name: "Comparative" })).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in with github/i })).toBeVisible();
  await screenshot(page, "01-login.png");
  await page.close();
}

async function captureOnboarding(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
) {
  const page = await newPage(browser);
  await page.addInitScript(() => {
    window.localStorage.removeItem("aihub.wizard.step");
    window.localStorage.removeItem("aihub.wizard.name");
  });
  await installMockComparativeApi(page, {
    artifacts: [artifactSummary],
    skills: alphaSkills,
    threads: alphaThreads,
    oauthStatus: { github: false },
    user: {
      displayName: "Casey",
      name: "Casey",
      email: "casey@example.com",
      assistantName: null,
      tourCompletedAt: null,
    },
  });
  await page.goto(`${baseUrl}/e2e/chat`);
  await expect(page.getByRole("heading", { name: "Name your assistant" })).toBeVisible();
  await screenshot(page, "02-first-run-name.png");

  const setupDialog = page.getByRole("dialog", { name: "Welcome setup" });
  await page.getByPlaceholder("Hub").fill("Atlas");
  await setupDialog.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect your tools" })).toBeVisible();
  await screenshot(page, "03-first-run-tools.png");
  await page.close();
}

async function captureMainSurfaces(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
) {
  const page = await newPage(browser);
  await installMockComparativeApi(page, {
    artifacts: [artifactSummary],
    artifactDetails: { [artifactSummary.id]: artifactDetail },
    skills: alphaSkills,
    threads: alphaThreads,
    oauthStatus: { github: true },
    user: {
      displayName: "Casey",
      name: "Casey",
      email: "casey@example.com",
      assistantName: "Atlas",
      tourCompletedAt: now,
    },
    onChat: async (_body, route) => {
      await fulfillSse(route, [
        { type: "meta", threadId: "thread-generated", modelId: "sonnet-4-6" },
        {
          type: "text-delta",
          delta:
            "I created a project health dashboard artifact and highlighted the top delivery risks.",
        },
        {
          type: "persisted",
          assistantMessageId: "assistant-generated",
          artifacts: [artifactSummary],
          recommendations: [recommendation],
        },
        { type: "done" },
      ]);
    },
  });

  await page.goto(`${baseUrl}/e2e/chat`);
  await expect(page.getByText("Talk to your work.")).toBeVisible();
  await screenshot(page, "05-chat-home.png");

  await page
    .getByPlaceholder(/ask anything/i)
    .fill("Turn these launch notes into a dashboard I can share.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Deploy this as an app")).toBeVisible();
  await screenshot(page, "06-chat-artifact-recommendation.png");

  await openSidebarButton(page, "Tools");
  await expect(page.getByRole("heading", { level: 1, name: "Tools" })).toBeVisible();
  await screenshot(page, "07-tools.png");

  await openSidebarButton(page, "Artifacts");
  await expect(page.getByRole("heading", { level: 1, name: "Artifacts" })).toBeVisible();
  await expect(page.getByText("project-health-dashboard.html")).toBeVisible();
  await screenshot(page, "08-artifacts.png");

  await openSidebarButton(page, "Feedback");
  await expect(page.getByRole("heading", { name: "Report feedback" })).toBeVisible();
  await screenshot(page, "09-feedback.png");
  await page.close();
}

async function openSidebarButton(page: Page, name: string) {
  const sidebar = page.locator('aside[aria-label="Primary"]');
  await expect(sidebar).toBeVisible();
  await sidebar.getByRole("button", { name, exact: true }).click();
}

async function screenshot(page: Page, filename: string) {
  await page.screenshot({
    path: path.join(outDir, filename),
    fullPage: true,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
