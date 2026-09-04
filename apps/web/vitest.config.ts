import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  // Use the React 17+ automatic JSX runtime so tsx server components imported
  // by tests don't need an explicit `import React` to run under vitest.
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    // #695: report-only coverage (no thresholds). Run via `pnpm test:coverage`.
    // Source dirs only, so Next.js output (.next/), static assets (public/,
    // including the copied DCV SDK), the Playwright suite (e2e/) and the
    // real-Postgres lane (__integration__/) never count toward the number.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      include: [
        "app/**",
        "components/**",
        "lib/**",
        "scripts/**",
        "instrumentation-client.ts",
        "middleware.ts",
      ],
    },
  },
});
