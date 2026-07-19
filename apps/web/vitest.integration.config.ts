import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * #444: the real-Postgres scoping suite. Separate vitest project so the unit
 * lane (`pnpm test`, `__tests__/**`) stays database-free. Run via
 * `INTEGRATION_DATABASE_URL=postgres://… pnpm test:integration` — the URL is
 * forwarded as DATABASE_URL so route handlers' `getDb()` singleton binds to
 * the test database. Suites skip (not fail) when no URL is provided.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    include: ["__integration__/**/*.integration.test.ts"],
    // Scoping tests share one database; serialize files to keep seeds
    // deterministic.
    fileParallelism: false,
    env: {
      DATABASE_URL: process.env.INTEGRATION_DATABASE_URL ?? "",
    },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
