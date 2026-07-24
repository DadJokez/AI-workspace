import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PORT ?? 3000);
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseUrl ?? `http://127.0.0.1:${port}`;
const nextAuthSecret =
  process.env.NEXTAUTH_SECRET ?? "playwright-local-secret-with-enough-length";
const localDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://aihub:aihub_dev@localhost:5432/aihub";
const coreEval = process.env.PLAYWRIGHT_CORE_EVAL === "1";
const coreRealModel =
  coreEval && process.env.PLAYWRIGHT_CORE_REAL_MODEL === "1";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  // The authenticated smoke drives real turns through a dev-mode server on a
  // 2-core CI runner; the suite sits right at the edge of Playwright's 30s
  // default, and a runner-speed dip (2026-07-19) tipped green tests into
  // deterministic timeouts. Headroom over precision: these are smoke gates,
  // not latency benchmarks.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL,
    trace: coreEval ? "retain-on-failure" : "on-first-retry",
    screenshot: coreEval ? "only-on-failure" : "off",
  },
  webServer: externalBaseUrl
    ? undefined
    : {
        command: `pnpm exec next dev --hostname 127.0.0.1 --port ${port}`,
        url: `${baseURL}/login`,
        reuseExistingServer: !process.env.CI && !coreEval,
        timeout: 120_000,
        env: {
          E2E_TEST_MODE: "1",
          NEXTAUTH_SECRET: nextAuthSecret,
          NEXTAUTH_URL: baseURL,
          DATABASE_URL: localDatabaseUrl,
          BEDROCK_CLIENT: coreRealModel
            ? "real"
            : coreEval
              ? "e2e-resource-canary"
              : "fake",
          OAUTH_ENCRYPTION_KEY:
            process.env.OAUTH_ENCRYPTION_KEY ??
            "playwright-oauth-encryption-key-at-least-32-characters",
          CHAT_RUN_IN_PROCESS_WORKER:
            process.env.PLAYWRIGHT_AUTH_SMOKE === "1" || coreEval ? "1" : "0",
          MEMORY_CAPTURE_IN_PROCESS_SCHEDULER: "0",
          GITHUB_WEBHOOK_SECRET: "playwright-github-webhook-secret",
          GITHUB_AUTH_CLIENT_ID: "playwright-local-client",
          GITHUB_AUTH_CLIENT_SECRET: "playwright-local-secret",
        },
      },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"] },
    },
  ],
});
