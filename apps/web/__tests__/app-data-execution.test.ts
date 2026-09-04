import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The executor is the scoping boundary: every lookup is keyed by the VIEWER's
// user id, a viewer without a ready+attested connection gets a connect state,
// only always-allowed read tools run, and upstream error text never escapes.

const loadUserMcpProviderStatus = vi.fn();
const buildUserMcpServers = vi.fn();
const connectMcpTools = vi.fn();
const resolveSalesforceConnection = vi.fn();
const queryReadOnlySoql = vi.fn();

vi.mock("@/lib/oauth/mcp-servers", () => ({
  loadUserMcpProviderStatus,
  buildUserMcpServers,
}));
vi.mock("@/lib/oauth/salesforce-token", () => ({ resolveSalesforceConnection }));
vi.mock("@/lib/salesforce/authorization", () => ({
  buildSalesforceTurnContext: ({
    userId,
    instanceUrl,
  }: {
    userId: string;
    instanceUrl: string;
  }) => ({ userId, instanceUrl, issuedAt: "t" }),
}));
class SalesforceApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
vi.mock("@/lib/salesforce/api", () => ({
  queryReadOnlySoql,
  SalesforceApiError,
  validateReadOnlySoql: (raw: string) => {
    if (!/^select\s/i.test(raw.trim())) throw new Error("not read-only");
    return raw.trim();
  },
}));
vi.mock("@ai-workspace/agent", () => ({
  connectMcpTools,
  mcpToolName: (provider: string, tool: string) => `${provider}__${tool}`,
}));

const db = {} as never;
const viewerUserId = "viewer-2";

const soqlBinding = {
  id: "pipeline",
  provider: "salesforce",
  toolName: "run_soql",
  pinnedArgs: { soql: "SELECT Id, Secret_Margin__c FROM Opportunity LIMIT 10" },
};
const githubBinding = {
  id: "open-prs",
  provider: "github",
  toolName: "list_pull_requests",
  pinnedArgs: { owner: "DadJokez", repo: "AI-workspace", state: "open" },
};

function readyStatus(provider: string, toolName: string) {
  return {
    connectedProviders: [provider],
    allowedProviders: [provider],
    deniedProviders: [],
    providerAvailability: { [provider]: { status: "ready" } },
    toolPolicies: { [provider]: { allowedTools: [toolName] } },
    toolPolicyDecisions: { [`${provider}__${toolName}`]: "always_allow" },
  };
}

async function execute(binding: typeof soqlBinding | typeof githubBinding) {
  const { executeAppDataBinding } = await import("@/lib/app-data-execution");
  return executeAppDataBinding({ db, viewerUserId, binding });
}

const handler = vi.fn();
const close = vi.fn(async () => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  loadUserMcpProviderStatus.mockResolvedValue(
    readyStatus("salesforce", "run_soql"),
  );
  resolveSalesforceConnection.mockResolvedValue({
    status: "ready",
    ready: true,
    accessToken: "viewer-token",
    instanceUrl: "https://na1.salesforce.com",
  });
  queryReadOnlySoql.mockResolvedValue({
    soql: soqlBinding.pinnedArgs.soql,
    totalSize: 1,
    done: true,
    records: [{ Id: "006xxx" }],
  });
  buildUserMcpServers.mockResolvedValue({
    mcpServers: {
      github: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: {} },
    },
    deniedProviders: [],
    toolPolicyDecisions: {},
    writeAuthorizationReceipts: [],
  });
  handler.mockResolvedValue({ pulls: [{ number: 802 }] });
  connectMcpTools.mockResolvedValue({
    tools: [
      { name: "github__list_pull_requests", policy: "always_allow", handler },
      { name: "github__create_issue", policy: "needs_approval", handler },
    ],
    providers: { github: 2 },
    failedProviders: [],
    close,
  });
});

afterEach(() => vi.resetModules());

describe("executeAppDataBinding — viewer gating", () => {
  it("denies a provider outside the viewer-identity gate before any lookup", async () => {
    const result = await execute({
      ...githubBinding,
      provider: "data-lake",
    });
    expect(result).toEqual({ kind: "denied", reason: "provider_not_viewer_identity" });
    expect(loadUserMcpProviderStatus).not.toHaveBeenCalled();
  });

  it("looks up provider state for the VIEWER only, scoped to the binding's provider", async () => {
    await execute(githubBinding);
    expect(loadUserMcpProviderStatus).toHaveBeenCalledWith(db, viewerUserId, {
      onlyProviders: ["github"],
    });
  });

  it("returns a connect state (never data) when the viewer has no connection", async () => {
    loadUserMcpProviderStatus.mockResolvedValue({
      connectedProviders: [],
      allowedProviders: [],
      deniedProviders: [],
      providerAvailability: {},
      toolPolicies: {},
      toolPolicyDecisions: {},
    });
    expect(await execute(soqlBinding)).toEqual({
      kind: "needs_connection",
      connectionStatus: "not_connected",
    });
    expect(queryReadOnlySoql).not.toHaveBeenCalled();
    expect(buildUserMcpServers).not.toHaveBeenCalled();
  });

  it("surfaces reconnect / pending-approval states as connect states", async () => {
    loadUserMcpProviderStatus.mockResolvedValue({
      ...readyStatus("salesforce", "run_soql"),
      providerAvailability: { salesforce: { status: "reconnect_required" } },
    });
    expect(await execute(soqlBinding)).toEqual({
      kind: "needs_connection",
      connectionStatus: "reconnect_required",
    });

    loadUserMcpProviderStatus.mockResolvedValue({
      ...readyStatus("github", "get_issue"),
      toolPolicyDecisions: {
        github__get_issue: "always_allow",
        github__list_pull_requests: "always_allow",
      },
    });
    // Connected, but this viewer has not approved list_pull_requests.
    expect(await execute(githubBinding)).toEqual({
      kind: "needs_connection",
      connectionStatus: "pending_approval",
    });
    expect(queryReadOnlySoql).not.toHaveBeenCalled();
    expect(connectMcpTools).not.toHaveBeenCalled();
  });

  it("denies a tool whose persisted policy is not always_allow, or is uncataloged", async () => {
    loadUserMcpProviderStatus.mockResolvedValue({
      ...readyStatus("github", "list_pull_requests"),
      toolPolicyDecisions: { github__list_pull_requests: "needs_approval" },
    });
    expect(await execute(githubBinding)).toEqual({
      kind: "denied",
      reason: "tool_policy_not_always_allow",
    });

    loadUserMcpProviderStatus.mockResolvedValue({
      ...readyStatus("github", "list_pull_requests"),
      toolPolicyDecisions: {},
    });
    expect(await execute(githubBinding)).toEqual({
      kind: "denied",
      reason: "tool_not_cataloged",
    });
    expect(connectMcpTools).not.toHaveBeenCalled();
  });
});

describe("executeAppDataBinding — Salesforce SOQL (structured rows path)", () => {
  it("re-validates the pinned SOQL before any lookup and refuses non-SELECT", async () => {
    const result = await execute({
      ...soqlBinding,
      pinnedArgs: { soql: "UPDATE Opportunity SET Name='x'" },
    });
    expect(result).toEqual({ kind: "invalid_binding" });
    expect(loadUserMcpProviderStatus).not.toHaveBeenCalled();
    expect(queryReadOnlySoql).not.toHaveBeenCalled();
  });

  it("runs the pinned query under the VIEWER's own token and returns legacy row fields", async () => {
    const result = await execute(soqlBinding);
    expect(result).toEqual({
      kind: "ok",
      data: { records: [{ Id: "006xxx" }], totalSize: 1, done: true },
      rowCount: 1,
      legacyFields: { records: [{ Id: "006xxx" }], totalSize: 1, done: true },
    });
    expect(resolveSalesforceConnection).toHaveBeenCalledWith(db, viewerUserId);
    expect(queryReadOnlySoql).toHaveBeenCalledWith(
      soqlBinding.pinnedArgs.soql,
      expect.objectContaining({
        accessToken: "viewer-token",
        turnContext: expect.objectContaining({ userId: viewerUserId }),
      }),
    );
  });

  it("returns a connect state when the viewer's Salesforce token is not ready", async () => {
    resolveSalesforceConnection.mockResolvedValue({
      status: "temporarily_unavailable",
      ready: false,
    });
    expect(await execute(soqlBinding)).toEqual({
      kind: "needs_connection",
      connectionStatus: "temporarily_unavailable",
    });
    expect(queryReadOnlySoql).not.toHaveBeenCalled();
  });

  it("never echoes the pinned query on failure — only a status category survives", async () => {
    // Salesforce INVALID_FIELD errors quote the submitted query verbatim.
    queryReadOnlySoql.mockRejectedValue(
      new SalesforceApiError(
        400,
        `${soqlBinding.pinnedArgs.soql}\n^ ERROR at Row:1:Column:12 No such column 'Secret_Margin__c' (INVALID_FIELD)`,
      ),
    );
    const result = await execute(soqlBinding);
    expect(result).toEqual({ kind: "source_error", category: "salesforce_error_400" });
    expect(JSON.stringify(result)).not.toContain("Secret_Margin__c");
  });
});

describe("executeAppDataBinding — generic catalog read tool via MCP", () => {
  it("mounts only this provider for the VIEWER, calls the pinned tool, and closes", async () => {
    loadUserMcpProviderStatus.mockResolvedValue(
      readyStatus("github", "list_pull_requests"),
    );
    const result = await execute(githubBinding);
    expect(result).toEqual({ kind: "ok", data: { pulls: [{ number: 802 }] } });
    expect(buildUserMcpServers).toHaveBeenCalledWith(db, viewerUserId, {
      onlyProviders: ["github"],
    });
    expect(connectMcpTools).toHaveBeenCalledWith(
      { github: expect.objectContaining({ url: "https://api.githubcopilot.com/mcp/" }) },
      { clientName: "comparative-app-data" },
    );
    expect(handler).toHaveBeenCalledWith(githubBinding.pinnedArgs, {
      userId: viewerUserId,
    });
    expect(close).toHaveBeenCalled();
    // The Salesforce path is never involved for another provider.
    expect(resolveSalesforceConnection).not.toHaveBeenCalled();
  });

  it("fails closed when the mounted tool's policy is not always_allow", async () => {
    loadUserMcpProviderStatus.mockResolvedValue(
      readyStatus("github", "create_issue"),
    );
    const result = await execute({ ...githubBinding, toolName: "create_issue" });
    expect(result).toEqual({ kind: "denied", reason: "tool_policy_not_always_allow" });
    expect(handler).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("reports mount and tool failures as categories without provider text", async () => {
    loadUserMcpProviderStatus.mockResolvedValue(
      readyStatus("github", "list_pull_requests"),
    );
    buildUserMcpServers.mockResolvedValueOnce({
      mcpServers: undefined,
      deniedProviders: [],
      toolPolicyDecisions: {},
      writeAuthorizationReceipts: [],
    });
    expect(await execute(githubBinding)).toEqual({
      kind: "source_error",
      category: "provider_mount_failed",
    });

    handler.mockRejectedValueOnce(
      new Error("GitHub: repository DadJokez/AI-workspace not found for token ghp_x"),
    );
    const result = await execute(githubBinding);
    expect(result).toEqual({ kind: "source_error", category: "tool_error" });
    expect(JSON.stringify(result)).not.toContain("DadJokez");
    expect(close).toHaveBeenCalled();
  });
});
