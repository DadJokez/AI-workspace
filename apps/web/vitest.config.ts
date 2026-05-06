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
  },
});
