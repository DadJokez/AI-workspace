import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubProviderEndpoints } from "@/lib/auth/github-provider-endpoints";
import { readDeploymentConfig } from "@/lib/deployment-config";

/**
 * Koch migration WP-05: the GitHub hosts are deployment settings. Unset, every
 * address is the github.com one the code used to spell out.
 */

const ENTERPRISE = {
  GITHUB_WEB_URL: "https://ghe.example",
  GITHUB_API_URL: "https://ghe.example/api/v3",
  GITHUB_MCP_URL: "https://ghe-mcp.example/mcp/",
};

function stubGitHubEnv(env: Record<string, string | undefined>) {
  for (const name of ["GITHUB_WEB_URL", "GITHUB_API_URL", "GITHUB_MCP_URL"]) {
    vi.stubEnv(name, env[name]);
  }
}

function json(data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GitHub host settings", () => {
  it("default to github.com when unset or blank", () => {
    const github = {
      webUrl: "https://github.com",
      apiUrl: "https://api.github.com",
      mcpUrl: "https://api.githubcopilot.com/mcp/",
    };
    expect(readDeploymentConfig({})).toMatchObject({ github, problems: [] });
    expect(
      readDeploymentConfig({ GITHUB_WEB_URL: " ", GITHUB_API_URL: "" }),
    ).toMatchObject({ github, problems: [] });
  });

  it("tell an unset MCP URL (the default) from an empty one (no MCP server)", () => {
    expect(readDeploymentConfig({}).github.mcpUrl).toBe(
      "https://api.githubcopilot.com/mcp/",
    );
    for (const empty of ["", "  "]) {
      const config = readDeploymentConfig({ GITHUB_MCP_URL: empty });
      expect(config.github.mcpUrl).toBeNull();
      expect(config.problems).toEqual([]);
    }
  });

  it("take GitHub Enterprise hosts and keep the MCP path as written", () => {
    expect(
      readDeploymentConfig({
        ...ENTERPRISE,
        GITHUB_WEB_URL: "https://ghe.example/",
      }),
    ).toMatchObject({
      github: {
        webUrl: "https://ghe.example",
        apiUrl: "https://ghe.example/api/v3",
        mcpUrl: "https://ghe-mcp.example/mcp/",
      },
      problems: [],
    });
  });

  it("report malformed URLs", () => {
    expect(
      readDeploymentConfig({
        GITHUB_WEB_URL: "ghe.example",
        GITHUB_API_URL: "ftp://ghe.example/api/v3",
        GITHUB_MCP_URL: "mcp",
      }).problems,
    ).toEqual([
      "GITHUB_WEB_URL must be an absolute http(s) URL",
      "GITHUB_API_URL must be an absolute http(s) URL",
      "GITHUB_MCP_URL must be an absolute http(s) URL or empty",
    ]);
  });

  it("refuse an enterprise host that leaves another address on github.com", () => {
    const webOnly = readDeploymentConfig({
      GITHUB_WEB_URL: ENTERPRISE.GITHUB_WEB_URL,
      GITHUB_MCP_URL: "",
    });
    expect(webOnly.problems).toEqual([
      "GITHUB_WEB_URL and GITHUB_API_URL must be set together",
    ]);

    const noMcp = readDeploymentConfig({
      GITHUB_WEB_URL: ENTERPRISE.GITHUB_WEB_URL,
      GITHUB_API_URL: ENTERPRISE.GITHUB_API_URL,
    });
    expect(noMcp.problems).toEqual([
      "GITHUB_MCP_URL must be set, or empty, when GITHUB_WEB_URL and GITHUB_API_URL are set",
    ]);
    // An enterprise token is never sent to the github.com MCP server.
    expect(noMcp.github.mcpUrl).toBeNull();
  });
});

describe("GitHub addresses with the settings unset", () => {
  beforeEach(() => {
    stubGitHubEnv({});
  });

  it("are the github.com ones for the connector's OAuth and MCP server", async () => {
    const oauth = await import("@/lib/oauth/github");
    expect(oauth.GITHUB_AUTHORIZE_URL).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(oauth.GITHUB_TOKEN_URL).toBe(
      "https://github.com/login/oauth/access_token",
    );

    const mcp = await import("@/lib/oauth/mcp-servers");
    expect(mcp.mcpProviderEndpointUrl("github")).toBe(
      "https://api.githubcopilot.com/mcp/",
    );
    expect(mcp.getMcpProviderExecutionStatus("github")).toEqual({
      executionConfigured: true,
    });
  });

  it("leave the sign-in provider on its own github.com endpoints", async () => {
    expect(
      githubProviderEndpoints("https://github.com", "https://api.github.com"),
    ).toEqual({});

    const { authOptions } = await import("@/lib/auth/nextauth");
    const provider = authOptions.providers.find((p) => p.id === "github") as {
      authorization: { url: string };
      token: string;
      userinfo: { url: string };
      options: Record<string, unknown>;
    };
    expect(provider.authorization.url).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(provider.token).toBe("https://github.com/login/oauth/access_token");
    expect(provider.userinfo.url).toBe("https://api.github.com/user");
    expect(Object.keys(provider.options).sort()).toEqual([
      "allowDangerousEmailAccountLinking",
      "clientId",
      "clientSecret",
    ]);
  });

  it("call api.github.com for webhook subscriptions", async () => {
    const { ensureGitHubRepositoryWebhookWithToken } = await import(
      "@/lib/github-webhook-subscriptions"
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json([{ id: 1, config: { url: "https://hook.example" } }]));
    await ensureGitHubRepositoryWebhookWithToken({
      accessToken: "token",
      repository: "platform/portal",
      webhookUrl: "https://hook.example",
      secret: "secret",
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/platform/portal/hooks?per_page=100",
    );
  });
});

describe("GitHub addresses on GitHub Enterprise", () => {
  beforeEach(() => {
    stubGitHubEnv(ENTERPRISE);
  });

  it("move the connector's OAuth and MCP server", async () => {
    const oauth = await import("@/lib/oauth/github");
    expect(oauth.GITHUB_AUTHORIZE_URL).toBe(
      "https://ghe.example/login/oauth/authorize",
    );
    expect(oauth.GITHUB_TOKEN_URL).toBe(
      "https://ghe.example/login/oauth/access_token",
    );
    const mcp = await import("@/lib/oauth/mcp-servers");
    expect(mcp.mcpProviderEndpointUrl("github")).toBe(
      "https://ghe-mcp.example/mcp/",
    );
  });

  it("move the sign-in provider's authorization, token and userinfo endpoints", async () => {
    const { authOptions } = await import("@/lib/auth/nextauth");
    const provider = authOptions.providers.find((p) => p.id === "github") as {
      options: ReturnType<typeof githubProviderEndpoints>;
    };
    expect(provider.options).toMatchObject({
      issuer: "https://ghe.example/login/oauth",
      authorization: "https://ghe.example/login/oauth/authorize",
      token: "https://ghe.example/login/oauth/access_token",
      userinfo: { url: "https://ghe.example/api/v3/user" },
    });
  });

  it("read a hidden primary address from the enterprise API", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json([
          { email: "second@koch.example", primary: false },
          { email: "first@koch.example", primary: true },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { userinfo } = githubProviderEndpoints(
      ENTERPRISE.GITHUB_WEB_URL,
      ENTERPRISE.GITHUB_API_URL,
    );
    if (typeof userinfo !== "object" || !userinfo.request) {
      throw new Error("expected a userinfo request handler");
    }
    const profile = await userinfo.request({
      client: { userinfo: async () => ({ id: 7, email: null }) },
      tokens: { access_token: "enterprise-token" },
    } as unknown as Parameters<typeof userinfo.request>[0]);

    expect(profile.email).toBe("first@koch.example");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ghe.example/api/v3/user/emails",
      { headers: { Authorization: "token enterprise-token" } },
    );
  });

  it("call the enterprise API for webhook subscriptions and follow its paging", async () => {
    const { ensureGitHubRepositoryWebhookWithToken } = await import(
      "@/lib/github-webhook-subscriptions"
    );
    const webhookUrl = "https://comparative.example/api/webhooks/github";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json([], {
          link: '<https://ghe.example/api/v3/repos/platform/portal/hooks?per_page=100&page=2>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(
        json([
          {
            id: 293,
            active: true,
            events: ["pull_request_review", "workflow_run"],
            config: { url: webhookUrl },
          },
        ]),
      )
      .mockResolvedValueOnce(json({ id: 293 }));

    await ensureGitHubRepositoryWebhookWithToken({
      accessToken: "token",
      repository: "platform/portal",
      webhookUrl,
      secret: "secret",
      fetchImpl,
    });

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://ghe.example/api/v3/repos/platform/portal/hooks?per_page=100",
      "https://ghe.example/api/v3/repos/platform/portal/hooks?per_page=100&page=2",
      "https://ghe.example/api/v3/repos/platform/portal/hooks/293",
    ]);
  });
});

describe("GitHub connector with no MCP server", () => {
  it("stays on offer but is not mountable", async () => {
    stubGitHubEnv({ GITHUB_MCP_URL: "" });
    const mcp = await import("@/lib/oauth/mcp-servers");
    expect(mcp.SUPPORTED_MCP_PROVIDERS).toContain("github");
    expect(mcp.MOUNTABLE_MCP_PROVIDERS).not.toContain("github");
    expect(mcp.getMcpProviderExecutionStatus("github")).toEqual({
      executionConfigured: false,
      reason: "execution_not_configured",
    });
    expect(mcp.isProviderComingSoon("github")).toBe(false);
  });
});
