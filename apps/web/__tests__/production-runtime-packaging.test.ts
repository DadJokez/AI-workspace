import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("production web runtime packaging", () => {
  it("ships and verifies the native PDF parser runtime", () => {
    const nextConfig = readFileSync(`${WEB_ROOT}/next.config.mjs`, "utf8");
    const dockerfile = readFileSync(`${WEB_ROOT}/Dockerfile`, "utf8");

    expect(nextConfig).toContain('serverExternalPackages: ["pdf-parse"');
    expect(nextConfig).toContain(
      "../../node_modules/.pnpm/@napi-rs+canvas*/node_modules/@napi-rs/canvas*/**/*",
    );
    expect(dockerfile).toContain("find /app/node_modules/.pnpm");
    expect(dockerfile).toContain(
      'node --input-type=module -e "const parser = await import(\'pdf-parse\')',
    );
    expect(dockerfile.indexOf("await import('pdf-parse')")).toBeLessThan(
      dockerfile.indexOf("USER nextjs"),
    );
  });
});
