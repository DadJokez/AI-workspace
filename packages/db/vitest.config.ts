import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // #695: report-only coverage (no thresholds). Run via `pnpm test:coverage`.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      include: ["src/**"],
    },
  },
});
