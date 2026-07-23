import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("production web runtime packaging", () => {
  it("ships and verifies the native PDF parser runtime", () => {
    const nextConfig = readFileSync(`${WEB_ROOT}/next.config.mjs`, "utf8");
    const dockerfile = readFileSync(`${WEB_ROOT}/Dockerfile`, "utf8");
    const verifier = readFileSync(
      `${WEB_ROOT}/scripts/verify-pdf-runtime.mjs`,
      "utf8",
    );

    expect(nextConfig).toContain('serverExternalPackages: ["pdf-parse"');
    expect(nextConfig).toContain(
      "../../node_modules/.pnpm/@napi-rs+canvas*/node_modules/@napi-rs/canvas*/**/*",
    );
    expect(nextConfig).toContain('"/api/chat": pdfRuntimeTraceIncludes');
    expect(nextConfig).toContain(
      '"/api/mcp/resources": pdfRuntimeTraceIncludes',
    );
    expect(dockerfile).toContain("find /app/node_modules/.pnpm");
    expect(dockerfile).toContain("node ./verify-pdf-runtime.mjs");
    expect(dockerfile.indexOf("node ./verify-pdf-runtime.mjs")).toBeLessThan(
      dockerfile.indexOf("USER nextjs"),
    );
    expect(verifier).toContain('import { PDFParse } from "pdf-parse"');
    expect(verifier).toContain("await parser.getText()");
    expect(verifier).toContain("PDF runtime smoke");
  });
});
