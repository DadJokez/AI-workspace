import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolActionKey } from "@/lib/tool-policy";

// The clean-502 + audit guarantee at the seams the executor mounts through.
// app-data-route.test.ts mocks the executor wholesale; here the route AND
// the executor are real, and only the provider seams — status load,
// Salesforce token resolution, MCP mount, MCP connect — are faked, each
// forced to REJECT. A rejection there must land exactly where a provider
// error lands: a 502 with the generic body, one `app_data_refresh` audit row
// carrying only a category, and never the thrown text (providers echo the
// author's pinned arguments in it).

const getSessionUser = vi.fn();
const canActorOpenApp = vi.fn();
const getLiveAppVersion = vi.fn();
const auditAppMutation = vi.fn();
const auditAdminDataAccess = vi.fn();
const loadWorkspaceArtifactById = vi.fn();
const loadAppVersionDataBindings = vi.fn();
const checkRateLimit = vi.fn();
const resolveAppPublication = vi.fn();
const isBindingIncludedInPublication = vi.fn();
const isPublicationManifestEnabled = vi.fn();
const loadUserMcpProviderStatus = vi.fn();
const buildUserMcpServers = vi.fn();
const resolveSalesforceConnection = vi.fn();
const connectMcpTools = vi.fn();

vi.mock("@/lib/auth/getSessionUser", () => ({ getSessionUser }));
vi.mock("@/lib/apps", () => ({
  canActorOpenApp,
  getLiveAppVersion,
  auditAppMutation,
}));
vi.mock("@/lib/admin-data-access", () => ({
  adminDataAccessJustification: () => null,
  auditAdminDataAccess,
}));
vi.mock("@/lib/workspace-artifacts", () => ({ loadWorkspaceArtifactById }));
vi.mock("@/lib/app-version-bindings", () => ({ loadAppVersionDataBindings }));
vi.mock("@/lib/request-limits", () => ({ checkRateLimit }));
vi.mock("@/lib/app-publication", () => ({
  resolveAppPublication,
  isBindingIncludedInPublication,
  isPublicationManifestEnabled,
}));
vi.mock("@/lib/oauth/mcp-servers", () => ({
  loadUserMcpProviderStatus,
  buildUserMcpServers,
}));
vi.mock("@/lib/oauth/salesforce-token", () => ({ resolveSalesforceConnection }));
vi.mock("@ai-workspace/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ai-workspace/agent")>()),
  connectMcpTools,
}));

const appRow = {
  id: "app-1",
  slug: "pipeline",
  ownerUserId: "author-1",
  status: "deployed",
  liveArtifactId: "artifact-live",
  liveVersionId: "version-live",
  archivedAt: null,
};

vi.mock("@ai-workspace/db", () => ({
  apps: {},
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [appRow] }),
      }),
    }),
  }),
}));

const viewer = { id: "viewer-2", email: "v@x.com", displayName: "V", role: "user" };
// Pinned-argument fragments that must never reach the browser or an audit row.
const SOQL_SECRET = "Secret_Margin__c";
const GITHUB_SECRET = "confidential-triage";
const soqlBinding = {
  id: "pipeline",
  provider: "salesforce",
  toolName: "run_soql",
  pinnedArgs: { soql: `SELECT Id, ${SOQL_SECRET} FROM Opportunity LIMIT 10` },
};
const githubBinding = {
  id: "open-prs",
  provider: "github",
  toolName: "list_pull_requests",
  pinnedArgs: { owner: "DadJokez", repo: "AI-workspace", labels: GITHUB_SECRET },
};

function readyStatus(provider: string, toolName: string) {
  return {
    connectedProviders: [provider],
    allowedProviders: [provider],
    deniedProviders: [],
    providerAvailability: { [provider]: { status: "ready" } },
    toolPolicies: { [provider]: { allowedTools: [toolName] } },
    toolPolicyDecisions: { [toolActionKey(provider, toolName)]: "always_allow" },
  };
}

async function callRoute(bindingId: string) {
  const { GET } = await import("@/app/api/apps/[id]/data/[bindingId]/route");
  return GET(new Request(`https://c.example/api/apps/app-1/data/${bindingId}`), {
    params: Promise.resolve({ id: "app-1", bindingId }),
  });
}

/** The same 502 + single category-only audit row every provider error gets. */
async function expectCleanSourceError(
  res: Response,
  binding: typeof soqlBinding | typeof githubBinding,
  category: string,
  secret: string,
) {
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body).toEqual({
    ok: false,
    error: "data_source_error",
    message: "The data source could not be reached.",
  });
  expect(auditAppMutation).toHaveBeenCalledTimes(1);
  expect(auditAppMutation).toHaveBeenCalledWith({
    db: expect.anything(),
    actorUserId: viewer.id,
    actionType: "app_data_refresh",
    appId: appRow.id,
    appSlug: appRow.slug,
    status: "failed",
    error: category,
    metadata: {
      bindingId: binding.id,
      provider: binding.provider,
      toolName: binding.toolName,
    },
  });
  expect(JSON.stringify(body)).not.toContain(secret);
  expect(JSON.stringify(auditAppMutation.mock.calls)).not.toContain(secret);
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionUser.mockResolvedValue(viewer);
  canActorOpenApp.mockResolvedValue(true);
  checkRateLimit.mockResolvedValue({
    allowed: true,
    limit: 30,
    remaining: 29,
    resetAt: new Date("2026-09-06T00:00:00Z"),
    retryAfterSeconds: 60,
  });
  getLiveAppVersion.mockResolvedValue({
    id: "version-live",
    artifactId: "artifact-live",
  });
  loadWorkspaceArtifactById.mockResolvedValue({
    id: "artifact-live",
    metadata: { dataBindings: [soqlBinding, githubBinding] },
  });
  loadAppVersionDataBindings.mockResolvedValue([soqlBinding, githubBinding]);
  resolveAppPublication.mockReturnValue({
    metadata: { dataMode: "live_via_viewer", connectorManifest: [] },
  });
  isBindingIncludedInPublication.mockReturnValue(true);
  isPublicationManifestEnabled.mockResolvedValue(true);
  auditAdminDataAccess.mockResolvedValue("skipped");
  loadUserMcpProviderStatus.mockResolvedValue(
    readyStatus("github", "list_pull_requests"),
  );
  buildUserMcpServers.mockResolvedValue({
    mcpServers: {
      github: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: {} },
    },
    deniedProviders: [],
    toolPolicyDecisions: {},
    writeAuthorizationReceipts: [],
  });
});

afterEach(() => vi.resetModules());

describe("GET /api/apps/[id]/data/[bindingId] — seam rejections", () => {
  it("502s and audits when the viewer's provider status cannot be loaded", async () => {
    loadUserMcpProviderStatus.mockRejectedValue(
      new Error(`attestation lookup failed: ${JSON.stringify(githubBinding.pinnedArgs)}`),
    );

    const res = await callRoute("open-prs");

    await expectCleanSourceError(res, githubBinding, "provider_status_failed", GITHUB_SECRET);
    expect(buildUserMcpServers).not.toHaveBeenCalled();
    expect(connectMcpTools).not.toHaveBeenCalled();
  });

  it("502s and audits when the viewer's MCP mount rejects", async () => {
    buildUserMcpServers.mockRejectedValue(
      new Error(`token decrypt failed: ${JSON.stringify(githubBinding.pinnedArgs)}`),
    );

    const res = await callRoute("open-prs");

    await expectCleanSourceError(res, githubBinding, "provider_mount_failed", GITHUB_SECRET);
    expect(connectMcpTools).not.toHaveBeenCalled();
  });

  it("502s and audits when the MCP connect rejects", async () => {
    connectMcpTools.mockRejectedValue(
      new Error(`connect failed: ${JSON.stringify(githubBinding.pinnedArgs)}`),
    );

    const res = await callRoute("open-prs");

    await expectCleanSourceError(res, githubBinding, "provider_unreachable", GITHUB_SECRET);
  });

  it("502s and audits when the viewer's Salesforce token cannot be resolved", async () => {
    loadUserMcpProviderStatus.mockResolvedValue(readyStatus("salesforce", "run_soql"));
    resolveSalesforceConnection.mockRejectedValue(
      new Error(`refresh failed for ${soqlBinding.pinnedArgs.soql}`),
    );

    const res = await callRoute("pipeline");

    await expectCleanSourceError(res, soqlBinding, "provider_mount_failed", SOQL_SECRET);
    expect(buildUserMcpServers).not.toHaveBeenCalled();
  });
});
