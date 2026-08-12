import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config.mjs";

/**
 * Pins the application-layer security headers an automated scanner (Mozilla
 * Observatory / Burp) checks first. next.config.mjs is plain JS, so the
 * exported `headers()` output is the testable surface.
 */

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

async function headerRules(): Promise<HeaderRule[]> {
  const rules = await nextConfig.headers?.();
  expect(rules).toBeDefined();
  return rules as unknown as HeaderRule[];
}

function ruleFor(rules: HeaderRule[], source: string): HeaderRule {
  const rule = rules.find((entry) => entry.source === source);
  if (!rule) throw new Error(`no header rule for ${source}`);
  return rule;
}

function headerValue(rule: HeaderRule, key: string): string | undefined {
  return rule.headers.find((header) => header.key === key)?.value;
}

function directives(policy: string): string[] {
  return policy.split("; ").map((directive) => directive.trim());
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("security headers", () => {
  it("sends the baseline header set on every path", async () => {
    const global = ruleFor(await headerRules(), "/:path*");

    expect(headerValue(global, "Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
    expect(headerValue(global, "X-Content-Type-Options")).toBe("nosniff");
    expect(headerValue(global, "Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(headerValue(global, "X-Frame-Options")).toBe("DENY");
  });

  it("ships the CSP report-only, never enforcing", async () => {
    const rules = await headerRules();
    const keys = rules.flatMap((rule) => rule.headers.map((h) => h.key));

    expect(keys).toContain("Content-Security-Policy-Report-Only");
    expect(keys).not.toContain("Content-Security-Policy");
  });

  it("derives the policy from what the app actually loads", async () => {
    const global = ruleFor(await headerRules(), "/:path*");
    const policy = headerValue(global, "Content-Security-Policy-Report-Only");
    expect(policy).toBeDefined();

    expect(directives(policy!)).toEqual([
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      // Next.js inlines its bootstrap; layout.tsx inlines the theme script.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      // Artifact previews are base64 data URLs; downloads use blob:.
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "media-src 'self' data: blob:",
      // PostHog is same-origin; the Studio live viewer signs AgentCore HTTPS
      // requests and upgrades its display channel to WSS in the browser.
      "connect-src 'self' https://bedrock-agentcore.us-east-1.amazonaws.com wss://bedrock-agentcore.us-east-1.amazonaws.com",
      "worker-src 'self' blob:",
      "form-action 'self'",
      "frame-src 'self' blob:",
      "frame-ancestors 'none'",
    ]);
  });

  it("only grants 'unsafe-eval' to the dev server", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    const devConfig = (await import("../next.config.mjs")).default;
    const rules = (await devConfig.headers?.()) as unknown as HeaderRule[];
    const policy = headerValue(ruleFor(rules, "/:path*"), "Content-Security-Policy-Report-Only");

    expect(policy).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
  });

  it("exempts only the deployed-app document from DENY framing", async () => {
    const rules = await headerRules();
    const deployedApp = ruleFor(rules, "/apps/:slug");

    // app/apps/[slug]/route.ts serves that document with its own enforcing
    // CSP carrying `frame-ancestors 'self'`; DENY would contradict it.
    expect(headerValue(deployedApp, "X-Frame-Options")).toBe("SAMEORIGIN");
    expect(
      headerValue(deployedApp, "Content-Security-Policy-Report-Only"),
    ).toContain("frame-ancestors 'self'");

    // Later rules overwrite earlier ones per key, so the exemption must come
    // after the global rule — and must relax nothing else.
    expect(rules.map((rule) => rule.source)).toEqual([
      "/:path*",
      "/apps/:slug",
    ]);
    expect(deployedApp.headers.map((header) => header.key)).toEqual([
      "X-Frame-Options",
      "Content-Security-Policy-Report-Only",
    ]);
  });
});
