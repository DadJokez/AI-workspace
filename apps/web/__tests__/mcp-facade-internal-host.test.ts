import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const INTERNAL_ORIGIN = "http://internal.example:8080";

const FACADES = [
  {
    name: "Google",
    path: "/api/mcp/google",
    load: async () => (await import("@/lib/google/mcp")).handleGoogleMcpRequest,
  },
  {
    name: "Salesforce",
    path: "/api/mcp/salesforce",
    load: async () =>
      (await import("@/lib/salesforce/mcp")).handleSalesforceMcpRequest,
  },
  {
    name: "Notion",
    path: "/api/mcp/notion",
    load: async () => (await import("@/lib/notion/mcp")).handleNotionMcpRequest,
  },
  {
    name: "Conversation resource",
    path: "/api/mcp/resources",
    load: async () =>
      (await import("@/lib/conversation-resource-mcp"))
        .handleConversationResourceMcpRequest,
  },
] as const;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
  vi.stubEnv("OAUTH_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// The request carries a bearer token but no relay token, so a request that
// passes the host check is still refused by the next control. The error
// message tells the two refusals apart.
function facadeRequest(url: string, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer delegated-token",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { message?: string } };
  return body.error?.message ?? "";
}

describe.each(FACADES)("$name MCP facade host check", ({ name, path, load }) => {
  it("refuses the internal host when no internal address is configured", async () => {
    vi.stubEnv("INTERNAL_BASE_URL", "");
    const handle = await load();

    const res = await handle(facadeRequest(`${INTERNAL_ORIGIN}${path}`));

    expect(res.status).toBe(403);
    expect(await errorMessage(res)).toBe(`${name} MCP host is not allowed.`);
  });

  it("accepts the configured internal host and still requires the relay", async () => {
    vi.stubEnv("INTERNAL_BASE_URL", INTERNAL_ORIGIN);
    const handle = await load();

    const res = await handle(facadeRequest(`${INTERNAL_ORIGIN}${path}`));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await errorMessage(res)).not.toMatch(/host is not allowed/);
  });

  it("accepts the internal host as a forwarded host only when configured", async () => {
    const forwarded = { "X-Forwarded-Host": "internal.example:8080" };

    vi.stubEnv("INTERNAL_BASE_URL", "");
    const refuse = await load();
    const refused = await refuse(
      facadeRequest(`https://comparative.example${path}`, forwarded),
    );
    expect(refused.status).toBe(403);
    expect(await errorMessage(refused)).toBe(
      `${name} MCP forwarded host is not allowed.`,
    );

    vi.resetModules();
    vi.stubEnv("INTERNAL_BASE_URL", INTERNAL_ORIGIN);
    const accept = await load();
    const accepted = await accept(
      facadeRequest(`https://comparative.example${path}`, forwarded),
    );
    expect(await errorMessage(accepted)).not.toMatch(/host is not allowed/);
  });

  it("keeps refusing a foreign host with an internal address configured", async () => {
    vi.stubEnv("INTERNAL_BASE_URL", INTERNAL_ORIGIN);
    const handle = await load();

    const res = await handle(facadeRequest(`https://evil.example${path}`));

    expect(res.status).toBe(403);
    expect(await errorMessage(res)).toBe(`${name} MCP host is not allowed.`);
  });

  it("keeps browser origins pinned to the public origin", async () => {
    vi.stubEnv("INTERNAL_BASE_URL", INTERNAL_ORIGIN);
    const handle = await load();

    const res = await handle(
      facadeRequest(`${INTERNAL_ORIGIN}${path}`, { Origin: INTERNAL_ORIGIN }),
    );

    expect(res.status).toBe(403);
    expect(await errorMessage(res)).toBe(`${name} MCP origin is not allowed.`);
  });
});
