import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@ai-workspace/db";

const RELAY_HMAC_MESSAGE = "comparative:notion-mcp-relay:v1";

function mockAttestations(provider = "notion") {
  vi.doMock("@/lib/tool-attestations", async () => {
    const actual = await vi.importActual<
      typeof import("@/lib/tool-attestations")
    >("@/lib/tool-attestations");
    return {
      ...actual,
      loadActiveToolAttestations: async () => [
        {
          provider,
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
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = async () => rows;
  chain.then = (resolve: (value: unknown) => void) => resolve(rows);
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

  it("mounts sufficiently scoped Google through the governed first-party MCP surface", async () => {
    vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
    vi.stubEnv(
      "OAUTH_ENCRYPTION_KEY",
      Buffer.alloc(32, 8).toString("base64"),
    );
    mockAttestations("google");
    const { encryptSecret } = await import("@/lib/oauth/crypto");
    const {
      buildUserMcpServers,
      loadUserMcpProviderStatus,
      MOUNTABLE_MCP_PROVIDERS,
      SUPPORTED_MCP_PROVIDERS,
    } = await import("@/lib/oauth/mcp-servers");

    expect(SUPPORTED_MCP_PROVIDERS).toContain("google");
    expect(MOUNTABLE_MCP_PROVIDERS).toContain("google");

    const rows = [
      {
        provider: "google",
        accessToken: encryptSecret("google-access-token"),
        refreshToken: encryptSecret("google-refresh-token"),
        expiresAt: new Date(Date.now() + 5 * 60_000),
        scope: googleScopes(),
      },
    ];

    const status = await loadUserMcpProviderStatus(
      dbWithOauthRows(rows),
      "user-1",
    );
    expect(status).toMatchObject({
      connectedProviders: ["google"],
      allowedProviders: ["google"],
      executionUnavailableProviders: [],
      providerAvailability: {
        google: {
          connected: true,
          tokenValid: true,
          executionConfigured: true,
          toolMountable: true,
          modelAvailable: true,
          status: "ready",
        },
      },
    });

    const mounted = await buildUserMcpServers(dbWithOauthRows(rows), "user-1");
    expect(mounted.mcpServers?.google).toMatchObject({
      type: "http",
      url: "https://comparative.example/api/mcp/google",
      headers: {
        Authorization: "Bearer google-access-token",
        "X-Comparative-MCP-Relay": expect.any(String),
        "X-Comparative-Google-Context": expect.any(String),
      },
      allowedTools: expect.arrayContaining([
        "search_mail",
        "get_message",
        "list_events",
        "prepare_event",
      ]),
    });
    const googleServer = mounted.mcpServers?.google;
    const allowedTools =
      googleServer && "url" in googleServer
        ? googleServer.allowedTools
        : undefined;
    expect(allowedTools).not.toContain("create_draft");
    expect(allowedTools).not.toContain("create_event");
    expect(mounted.requiredToolName).toBeUndefined();
  });

  it("mounts only the confirmed Calendar write instead of a replacement proposal", async () => {
    vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
    vi.stubEnv(
      "OAUTH_ENCRYPTION_KEY",
      Buffer.alloc(32, 8).toString("base64"),
    );
    mockAttestations("google");
    const { encryptSecret } = await import("@/lib/oauth/crypto");
    const { buildUserMcpServers } = await import("@/lib/oauth/mcp-servers");
    const now = Date.now();
    const rows = [
      {
        provider: "google",
        accessToken: encryptSecret("google-access-token"),
        refreshToken: encryptSecret("google-refresh-token"),
        expiresAt: new Date(now + 5 * 60_000),
        scope: googleScopes(),
      },
    ];

    const mounted = await buildUserMcpServers(
      dbWithOauthRows(rows),
      "user-1",
      {
        turnContext: {
          runId: "run-confirm",
          threadId: "thread-1",
          prompt: "confirm",
          interactive: true,
          history: [
            {
              role: "assistant",
              toolResults: [
                {
                  output: {
                    kind: "google_calendar_event_proposal",
                    proposalId: "00000000-0000-4000-8000-000000000297",
                    issuedRunId: "run-prepare",
                    issuedAt: new Date(now - 60_000).toISOString(),
                    expiresAt: new Date(now + 10 * 60_000).toISOString(),
                    calendarId: "primary",
                    title: "Confirmed event",
                    start: "2026-07-16T16:00:00-04:00",
                    end: "2026-07-16T16:15:00-04:00",
                    timeZone: "America/New_York",
                    attendees: [],
                    sendInvitations: false,
                  },
                },
              ],
            },
          ],
        },
      },
    );

    const googleServer = mounted.mcpServers?.google;
    const allowedTools =
      googleServer && "url" in googleServer
        ? googleServer.allowedTools
        : undefined;
    expect(allowedTools).toContain("create_event");
    expect(allowedTools).not.toContain("prepare_event");
    expect(allowedTools).not.toContain("create_draft");
    expect(mounted.requiredToolName).toBe("google__create_event");
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

function googleScopes(): string {
  return [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events.owned",
  ].join(" ");
}
