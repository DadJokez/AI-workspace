import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findTokenShapedContent } from "./helpers/token-shapes";

/**
 * Post-build client/server boundary check (#807). Scans every JavaScript
 * chunk Next.js emits for the browser for credential material and for the
 * fingerprints of server-only token modules — a client component importing
 * the OAuth crypto, the token store, or a secret env name would ship those
 * strings to every browser even though typecheck passes.
 *
 * Runs only when `next build` has produced `.next/static`; CI's unit lane
 * runs before its build step, so this reports as skipped there and is meant
 * for a post-build invocation (`pnpm build && pnpm test`).
 */
const STATIC_DIR = path.resolve(__dirname, "..", ".next", "static");
const built = existsSync(STATIC_DIR);

/**
 * Strings that only exist in Comparative's server-only token modules or the
 * schema. Node crypto API names (`createDecipheriv`, `aes-256-gcm`) are
 * deliberately NOT markers: exceljs ships a browserified `crypto-browserify`
 * that carries them, so the fingerprint is our own module's unique strings.
 */
const SERVER_ONLY_MARKERS = [
  "oauth_tokens",
  "OAUTH_ENCRYPTION_KEY",
  "encrypted payload too short",
  "SALESFORCE_CLIENT_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "NOTION_CLIENT_SECRET",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_AUTH_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "NEXTAUTH_SECRET",
];

function listJavaScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe.skipIf(!built)(
  "built client bundles (skipped until `next build` has produced apps/web/.next/static)",
  () => {
    const files = built ? listJavaScriptFiles(STATIC_DIR) : [];

    it("exist", () => {
      expect(files.length).toBeGreaterThan(0);
    });

    it("contain no credential material", () => {
      const findings = files.flatMap((file) => {
        const hits = findTokenShapedContent(readFileSync(file, "utf8"));
        return hits.length > 0
          ? [`${path.relative(STATIC_DIR, file)}: ${hits.join(", ")}`]
          : [];
      });
      expect(findings).toEqual([]);
    });

    it("do not bundle server-only token modules", () => {
      const findings = files.flatMap((file) => {
        const text = readFileSync(file, "utf8");
        const hits = SERVER_ONLY_MARKERS.filter((marker) =>
          text.includes(marker),
        );
        return hits.length > 0
          ? [`${path.relative(STATIC_DIR, file)}: ${hits.join(", ")}`]
          : [];
      });
      expect(findings).toEqual([]);
    });
  },
);
