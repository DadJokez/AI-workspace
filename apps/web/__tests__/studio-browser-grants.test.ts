import { describe, expect, it } from "vitest";
import {
  isTrustedSandboxHostname,
  normalizeGrantPath,
  rewriteSandboxRedirect,
  studioBrowserGrantBootstrap,
} from "@/lib/studio-browser-grants";
import { studioBrowserGrantUrl } from "@/lib/studio-browser";

const grantId = "00000000-0000-4000-8000-000000000710";

describe("Studio Browser grants", () => {
  it("keeps bearer grants in a fragment that never reaches request logs", () => {
    const value = studioBrowserGrantUrl(
      "https://comparative.example",
      grantId,
      "secret-token",
    );
    const url = new URL(value);
    expect(url.search).toBe("");
    expect(url.hash).toBe("#grant=secret-token");

    const bootstrap = studioBrowserGrantBootstrap(grantId);
    expect(bootstrap).toContain("location.hash.slice(1)");
    expect(bootstrap).toContain("history.replaceState");
    expect(bootstrap).not.toContain("location.search");
  });

  it("normalizes safe paths and rejects traversal or control characters", () => {
    expect(normalizeGrantPath(["assets", "app.js"])).toBe(
      "/assets/app.js",
    );
    expect(() => normalizeGrantPath(["..", "secret"])).toThrow();
    expect(() => normalizeGrantPath(["folder%2Fsecret"])).toThrow();
    expect(() => normalizeGrantPath(["bad%00name"])).toThrow();
  });

  it("accepts only registered-style private DNS names", () => {
    expect(isTrustedSandboxHostname("task-123.comparative.internal")).toBe(
      true,
    );
    expect(isTrustedSandboxHostname("comparative.internal")).toBe(false);
    expect(isTrustedSandboxHostname("task-123.example.com")).toBe(false);
    expect(isTrustedSandboxHostname("bad..comparative.internal")).toBe(false);
  });

  it("rewrites only same-host, same-port sandbox redirects", () => {
    expect(
      rewriteSandboxRedirect({
        location: "/next?view=1&grant=drop-me",
        upstreamUrl: new URL("http://task-123.comparative.internal:3000/"),
        expectedHostname: "task-123.comparative.internal",
        expectedPort: 3000,
        grantId,
      }),
    ).toBe(`/api/studio/browser/grants/${grantId}/next?view=1`);
    expect(() =>
      rewriteSandboxRedirect({
        location: "http://169.254.169.254/latest",
        upstreamUrl: new URL("http://task-123.comparative.internal:3000/"),
        expectedHostname: "task-123.comparative.internal",
        expectedPort: 3000,
        grantId,
      }),
    ).toThrow(/leave its authorized origin/);
    expect(() =>
      rewriteSandboxRedirect({
        location: "/bad%ZZ",
        upstreamUrl: new URL("http://task-123.comparative.internal:3000/"),
        expectedHostname: "task-123.comparative.internal",
        expectedPort: 3000,
        grantId,
      }),
    ).toThrow(/invalid redirect/);
  });
});
