import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@ai-workspace/db";

const RELAY_HMAC_MESSAGE = "comparative:notion-mcp-relay:v1";

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
  it("makes linked Notion model-available through the internal endpoint by default", async () => {
    mockAttestations();
    const {
      loadUserMcpProviderStatus,
      MOUNTABLE_MCP_PROVIDERS,
      SUPPORTED_MCP_PROVIDERS,
    } = await import("@/lib/oauth/mcp-servers");

    expect(SUPPORTED_MCP_PROVIDERS).toContain("notion");
    expect(MOUNTABLE_MCP_PROVIDERS).toContain("notion");

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
      executionUnavailableProviders: [],
      providerAvailability: {
        notion: {
          connected: true,
          userApproved: true,
          executionConfigured: true,
          toolMountable: true,
          modelAvailable: true,
          status: "ready",
        },
      },
    });
  });

  it("mounts Notion with the delegated bearer token against the internal endpoint by default", async () => {
    vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
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
      url: "https://comparative.example/api/mcp/notion",
      headers: {
        Authorization: "Bearer notion-access-token",
        "X-Comparative-MCP-Relay": relayToken(
          Buffer.alloc(32, 8).toString("base64"),
        ),
      },
    });
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
    const notionServer = result.mcpServers?.notion;
    expect(
      notionServer && "headers" in notionServer
        ? notionServer.headers
        : undefined,
    ).not.toHaveProperty("X-Comparative-MCP-Relay");
  });

  it("does not treat hosted Notion MCP as a compatible delegated-token endpoint", async () => {
    vi.stubEnv("NOTION_MCP_ENDPOINT_URL", "https://mcp.notion.com/mcp");
    mockAttestations();
    const { loadUserMcpProviderStatus } = await import(
      "@/lib/oauth/mcp-servers"
    );

    const status = await loadUserMcpProviderStatus(
      dbWithOauthRows([
        { provider: "notion", expiresAt: new Date(Date.now() + 60_000) },
      ]),
      "user-1",
    );

    expect(status.providerAvailability?.notion).toMatchObject({
      executionConfigured: false,
      status: "execution_not_configured",
    });
  });

  it("fails closed when an explicit Notion endpoint override is invalid", async () => {
    vi.stubEnv("NOTION_MCP_ENDPOINT_URL", "not a url");
    mockAttestations();
    const { loadUserMcpProviderStatus } = await import(
      "@/lib/oauth/mcp-servers"
    );

    const status = await loadUserMcpProviderStatus(
      dbWithOauthRows([
        { provider: "notion", expiresAt: new Date(Date.now() + 60_000) },
      ]),
      "user-1",
    );

    expect(status.providerAvailability?.notion).toMatchObject({
      executionConfigured: false,
      status: "execution_not_configured",
    });
  });
});

function relayToken(key: string): string {
  return createHmac("sha256", key).update(RELAY_HMAC_MESSAGE).digest("hex");
}
