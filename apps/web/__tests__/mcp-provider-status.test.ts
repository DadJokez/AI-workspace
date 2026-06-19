import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@ai-workspace/db";

function mockAttestations() {
  vi.doMock("@/lib/tool-attestations", async () => {
    const actual = await vi.importActual<
      typeof import("@/lib/tool-attestations")
    >("@/lib/tool-attestations");
    return {
      ...actual,
      loadActiveToolAttestations: async () => [
        {
          provider: "notion",
          scopeType: "provider",
          category: null,
          toolName: null,
          action: "admin",
        },
      ],
      loadToolCatalogForProviders: async () => [],
    };
  });
}

function dbWithOauthRows(rows: Array<Record<string, unknown>>): Database {
  const chain = {
    from: () => chain,
    where: async () => rows,
  };
  return {
    select: () => chain,
  } as unknown as Database;
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("MCP provider status", () => {
  it("recognizes active Notion connections and ignores expired tokens", async () => {
    mockAttestations();
    const { loadUserMcpProviderStatus, SUPPORTED_MCP_PROVIDERS } = await import(
      "@/lib/oauth/mcp-servers"
    );

    expect(SUPPORTED_MCP_PROVIDERS).toContain("notion");

    const status = await loadUserMcpProviderStatus(
      dbWithOauthRows([
        { provider: "notion", expiresAt: new Date(Date.now() + 60_000) },
        { provider: "github", expiresAt: new Date(Date.now() - 60_000) },
      ]),
      "user-1",
    );

    expect(status).toMatchObject({
      connectedProviders: ["notion"],
      allowedProviders: ["notion"],
      deniedProviders: [],
    });
  });

  it("does not mount Notion without a compatible MCP endpoint", async () => {
    mockAttestations();
    const { buildUserMcpServers } = await import("@/lib/oauth/mcp-servers");

    const result = await buildUserMcpServers(
      dbWithOauthRows([
        {
          provider: "notion",
          accessToken: "not-decrypted-without-endpoint",
          expiresAt: null,
        },
      ]),
      "user-1",
    );

    expect(result).toEqual({ mcpServers: undefined, deniedProviders: [] });
  });

  it("mounts Notion with the delegated bearer token when an endpoint is configured", async () => {
    vi.stubEnv("NOTION_MCP_ENDPOINT_URL", "https://notion-mcp.example/mcp");
    vi.stubEnv(
      "OAUTH_ENCRYPTION_KEY",
      Buffer.alloc(32, 8).toString("base64"),
    );
    mockAttestations();
    const { encryptSecret } = await import("@/lib/oauth/crypto");
    const { buildUserMcpServers } = await import("@/lib/oauth/mcp-servers");

    const result = await buildUserMcpServers(
      dbWithOauthRows([
        {
          provider: "notion",
          accessToken: encryptSecret("notion-access-token"),
          expiresAt: null,
        },
      ]),
      "user-1",
    );

    expect(result.mcpServers?.notion).toMatchObject({
      type: "http",
      url: "https://notion-mcp.example/mcp",
      headers: { Authorization: "Bearer notion-access-token" },
    });
  });
});
