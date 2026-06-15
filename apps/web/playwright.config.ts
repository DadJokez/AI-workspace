import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PORT ?? 3000);
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseUrl ?? `http://127.0.0.1:${port}`;
const nextAuthSecret =
  process.env.NEXTAUTH_SECRET ?? "playwright-local-secret-with-enough-length";
const localDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://aihub:aihub_dev@localhost:5432/aihub";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: externalBaseUrl
    ? undefined
    : {
        command: `pnpm exec next dev --hostname 127.0.0.1 --port ${port}`,
        url: `${baseURL}/login`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          E2E_TEST_MODE: "1",
          NEXTAUTH_SECRET: nextAuthSecret,
          NEXTAUTH_URL: baseURL,
          DATABASE_URL: localDatabaseUrl,
          BEDROCK_CLIENT: "fake",
          CHAT_RUN_IN_PROCESS_WORKER: "0",
          MEMORY_CAPTURE_IN_PROCESS_SCHEDULER: "0",
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
