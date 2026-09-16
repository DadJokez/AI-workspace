import { describe, expect, it, vi } from "vitest";
import type { Database } from "@ai-workspace/db";
import {
  assertStudioPreviewIsolation,
  loadStudioBrowserGrantPayload,
  type StudioBrowserGrantContext,
  isTrustedSandboxHostname,
  normalizeGrantPath,
  rewriteSandboxRedirect,
  studioBrowserGrantBootstrap,
} from "@/lib/studio-browser-grants";
import { studioBrowserGrantUrl } from "@/lib/studio-browser";

const grantId = "00000000-0000-4000-8000-000000000710";

describe("Studio Browser grants", () => {
  it("fails closed for private multi-file previews without disabling self-contained previews", () => {
    expect(() => assertStudioPreviewIsolation("sandbox")).toThrow(/temporarily unavailable/);
    expect(() => assertStudioPreviewIsolation("artifact")).not.toThrow();
    expect(() => assertStudioPreviewIsolation("app")).not.toThrow();
  });
  it("rejects private sandbox delivery before DB or upstream access", async () => {
    const now = new Date("2026-09-15T00:00:00Z");
    const expiresAt = new Date(now.getTime() + 60_000);
    const context = {
      grant: { targetKind: "sandbox", expiresAt, revokedAt: null },
      session: { status: "ready", expiresAt },
    } as StudioBrowserGrantContext;
    const fetchImpl = vi.fn();
    await expect(loadStudioBrowserGrantPayload({
      db: {} as Database, context, pathSegments: [], search: "", method: "GET", now, fetchImpl,
    })).rejects.toMatchObject({ status: 503, code: "browser_sandbox_isolation_required" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("delivers self-contained artifacts with an enforcing opaque-origin policy", async () => {
    const now = new Date("2026-09-15T00:00:00Z");
    const expiresAt = new Date(now.getTime() + 60_000);
    const context = {
      grant: { id: grantId, targetKind: "artifact", expiresAt, revokedAt: null, userId: "viewer", threadId: "thread", targetResourceId: "artifact" },
      session: { id: "session", status: "ready", expiresAt },
    } as StudioBrowserGrantContext;
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "artifact", content: "<h1>Preview</h1>", mimeType: "text/html" }] }) }) }),
      insert: () => ({ values: vi.fn() }),
    } as unknown as Database;
    const payload = await loadStudioBrowserGrantPayload({ db, context, pathSegments: [], search: "", method: "GET", now });
    expect(payload.status).toBe(200);
    expect(payload.body).toContain("<h1>Preview</h1>");
    expect(payload.headers.get("content-security-policy")).toContain("sandbox allow-scripts;");
    expect(payload.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(payload.headers.get("content-security-policy")).not.toContain("allow-same-origin");
  });
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
