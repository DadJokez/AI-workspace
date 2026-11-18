import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Koch migration WP-04: ENABLED_CONNECTOR_PROVIDERS removes a connector from
 * the whole product. These tests load the real modules with Google and Notion
 * turned off.
 */

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
  vi.stubEnv("ENABLED_CONNECTOR_PROVIDERS", "github,salesforce");
  vi.stubEnv("OAUTH_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/auth/requireSession");
});

describe("connector provider switch", () => {
  it("shrinks the supported and mountable provider lists", async () => {
    const servers = await import("@/lib/oauth/mcp-servers");

    expect(servers.SUPPORTED_MCP_PROVIDERS).toEqual(["github", "salesforce"]);
    expect(servers.MOUNTABLE_MCP_PROVIDERS).toEqual(["github", "salesforce"]);
    expect(servers.getMcpProviderExecutionStatus("google")).toEqual({
      executionConfigured: false,
      reason: "unsupported_provider",
    });
    expect(servers.isMcpProviderExecutionConfigured("notion")).toBe(false);
  });

  it("offers every provider when the variable is unset", async () => {
    vi.stubEnv("ENABLED_CONNECTOR_PROVIDERS", "");
    const servers = await import("@/lib/oauth/mcp-servers");

    expect([...servers.SUPPORTED_MCP_PROVIDERS].sort()).toEqual([
      "github",
      "google",
      "notion",
      "salesforce",
    ]);
  });

  it("answers 404 on a disabled connector's OAuth and facade routes without touching the session", async () => {
    const requireSession = vi.fn();
    vi.doMock("@/lib/auth/requireSession", () => ({ requireSession }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const request = (path: string) =>
      new Request(`https://comparative.example${path}`);
    const statuses = [
      (await (await import("@/app/api/oauth/google/start/route")).GET()).status,
      (
        await (
          await import("@/app/api/oauth/google/callback/route")
        ).GET(request("/api/oauth/google/callback?code=x&state=y"))
      ).status,
      (await (await import("@/app/api/oauth/notion/start/route")).GET()).status,
      (
        await (
          await import("@/app/api/oauth/notion/callback/route")
        ).GET(request("/api/oauth/notion/callback?code=x&state=y"))
      ).status,
      (
        await (
          await import("@/app/api/mcp/google/route")
        ).POST(
          new Request("https://comparative.example/api/mcp/google", {
            method: "POST",
            body: "{}",
          }),
        )
      ).status,
      (
        await (
          await import("@/app/api/mcp/notion/route")
        ).POST(
          new Request("https://comparative.example/api/mcp/notion", {
            method: "POST",
            body: "{}",
          }),
        )
      ).status,
    ];

    expect(statuses).toEqual([404, 404, 404, 404, 404, 404]);
    expect(requireSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps an enabled connector's routes working", async () => {
    vi.doMock("@/lib/auth/requireSession", () => ({
      requireSession: async () => ({
        error: new Response(null, { status: 401 }),
      }),
    }));

    const start = await (
      await import("@/app/api/oauth/salesforce/start/route")
    ).GET();
    const facade = await (
      await import("@/app/api/mcp/salesforce/route")
    ).POST(
      new Request("https://comparative.example/api/mcp/salesforce", {
        method: "POST",
        body: "{}",
      }),
    );

    // Past the switch: the session check and the facade's own controls answer.
    expect(start.status).toBe(401);
    expect(facade.status).not.toBe(404);
  });

  it("never reads or refreshes a stored grant for a disabled connector", async () => {
    const { resolveGoogleConnection } = await import("@/lib/oauth/google-token");
    const db = {
      select: vi.fn(() => {
        throw new Error("the database must not be queried");
      }),
    };

    await expect(
      resolveGoogleConnection(db as never, "user-1"),
    ).resolves.toEqual({
      status: "not_connected",
      connected: false,
      ready: false,
    });
    expect(db.select).not.toHaveBeenCalled();
  });
});
