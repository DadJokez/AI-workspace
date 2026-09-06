import { Param, SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findTokenShapedContent } from "./helpers/token-shapes";

/**
 * Token-handler discipline for deployed apps (#807, re-verified on the #802
 * generic binding path). A connected viewer opens a live-data app and
 * refreshes a binding; everything the browser can see — the served document,
 * the binding data response, the connect/error responses, the serialized
 * artifact metadata — is scanned for credential shapes, and the viewer's
 * token is shown to leave the server toward the provider only. The scoping
 * spine (viewer's token, never the author's) is covered by
 * app-data-route.test.ts and app-data-execution.test.ts; this file is about
 * *where the token can go*.
 *
 * Only the seams that touch the database, the session, or the network are
 * faked. The bootstrap injection, publication resolution, per-version
 * binding resolution, provider status + attestation gate, MCP mount spec,
 * SOQL client, and CSP are the real modules, reading from a table-keyed
 * database fake that applies each query's WHERE bindings — so a lookup keyed
 * by one user can never return another user's rows.
 */

const getSessionUser = vi.fn();
const canActorOpenApp = vi.fn();
const getLiveAppVersion = vi.fn();
const auditAppMutation = vi.fn();
const auditAdminDataAccess = vi.fn();
const loadWorkspaceArtifactById = vi.fn();
const checkRateLimit = vi.fn();
const resolveSalesforceConnection = vi.fn();
const connectMcpTools = vi.fn();

// Table sentinels with named columns: drizzle binds each WHERE value as a
// `Param` carrying its column, which is what lets the fake filter rows.
const column = (name: string) => ({ name, mapToDriverValue: (v: unknown) => v });
function table(name: string, columns: string[]) {
  return {
    __table: name,
    ...Object.fromEntries(columns.map((c) => [c, column(c)])),
  };
}
const schema = {
  apps: table("apps", ["id", "slug", "ownerUserId"]),
  users: table("users", ["id", "displayName"]),
  appVersionDataBindings: table("app_version_data_bindings", [
    "appVersionId",
    "bindingId",
    "provider",
    "toolName",
    "pinnedArgs",
    "label",
  ]),
  oauthTokens: table("oauth_tokens", [
    "userId",
    "provider",
    "accessToken",
    "expiresAt",
    "revokedAt",
  ]),
  userToolAttestations: table("user_tool_attestations", [
    "userId",
    "provider",
    "scopeType",
    "category",
    "toolCatalogId",
    "toolName",
    "action",
    "revokedAt",
  ]),
  toolsCatalog: table("tools_catalog", [
    "id",
    "provider",
    "toolName",
    "category",
    "action",
    "policy",
    "requiresAttestation",
    "enabled",
  ]),
  mcpServers: table("mcp_servers", ["slug", "status"]),
};
type Row = Record<string, unknown>;
const rowsByTable = new Map<object, Row[]>();
const queries: Array<{ table: string; where: Record<string, unknown[]> }> = [];

/** Column → values a WHERE clause bound (`eq` → one, `inArray` → many). */
function boundValues(
  condition: unknown,
  bound = new Map<string, unknown[]>(),
): Map<string, unknown[]> {
  if (condition instanceof Param) {
    const name = (condition.encoder as { name?: string }).name;
    if (name) bound.set(name, [...(bound.get(name) ?? []), condition.value]);
  } else if (condition instanceof SQL) {
    for (const chunk of condition.queryChunks) boundValues(chunk, bound);
  } else if (Array.isArray(condition)) {
    for (const chunk of condition) boundValues(chunk, bound);
  }
  return bound;
}

// A row is returned only when every bound column it carries matches — a
// user-keyed lookup never sees another user's rows, a version-keyed lookup
// never sees another version's pins, a catalog lookup gets its own tool.
function matching(bound: Map<string, unknown[]>) {
  return (row: Row) =>
    [...bound].every(
      ([name, values]) => !(name in row) || values.includes(row[name]),
    );
}

function fakeDb() {
  return {
    select: () => {
      let target: { __table: string } | null = null;
      const bound = new Map<string, unknown[]>();
      const run = () => {
        if (!target) throw new Error("select without from");
        queries.push({ table: target.__table, where: Object.fromEntries(bound) });
        return (rowsByTable.get(target) ?? []).filter(matching(bound));
      };
      const chain = {
        from(next: { __table: string }) {
          target = next;
          return chain;
        },
        innerJoin: () => chain,
        where(condition: unknown) {
          boundValues(condition, bound);
          return chain;
        },
        limit: () => chain,
        then(resolve: (rows: Row[]) => void, reject: (err: unknown) => void) {
          return Promise.resolve().then(run).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

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
vi.mock("@/lib/request-limits", () => ({ checkRateLimit }));
vi.mock("@/lib/oauth/salesforce-token", () => ({ resolveSalesforceConnection }));
vi.mock("@ai-workspace/db", () => ({ ...schema, getDb: fakeDb }));
// The MCP client is the network seam for generic read tools; everything that
// builds the mount spec (token decrypt, headers, endpoint, tool policies) is
// real.
vi.mock("@ai-workspace/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ai-workspace/agent")>()),
  connectMcpTools,
}));

// Realistic credentials (fixtures — not real): a Salesforce session id, the
// ciphertext the token store would hold, a GitHub token in the shape the
// secret scanner flags, and a pinned query whose fragments must never reach
// the viewer.
const VIEWER_TOKEN =
  "00D5g000004YzABEA2!AQEAQOx1kJ8xxg8s5m1VJ8xxg8s5m1VJ8xxg8s5m1VJ8xxg8s5m1VJ8xxg8s5m1V";
const STORED_CIPHERTEXT = "v1:c2FsdGVkX1-fixture-ciphertext-Q0lQSEVSVEVYVA==";
const GITHUB_TOKEN = `ghp_${"F1xTur3".repeat(6)}`;
const INSTANCE_URL = "https://viewer-org.my.salesforce.com";
const PINNED_QUERY =
  "SELECT Id, Name, Secret_Margin__c FROM Opportunity WHERE StageName = 'Closed Won' LIMIT 25";
const QUERY_FRAGMENTS = ["Secret_Margin__c", "StageName", "Closed Won"];
const GITHUB_PINNED_ARGS = {
  owner: "DadJokez",
  repo: "AI-workspace",
  labels: "confidential-triage",
};
const PROVIDER_HOSTS = [
  "salesforce.com",
  "force.com",
  "googleapis.com",
  "google.com",
  "github.com",
  "notion.com",
  "notion.so",
];

const appRow = {
  id: "app-1",
  slug: "pipeline",
  ownerUserId: "author-1",
  status: "deployed",
  liveArtifactId: "artifact-live",
  liveVersionId: "version-live",
  archivedAt: null,
};
const viewer = { id: "viewer-2", email: "v@x.com", displayName: "V", role: "user" };
// The artifact was authored on the #407 shape; `deployAppVersion` pins the
// normalized generic shape (salesforce/run_soql) as the version's rows.
const legacyBinding = {
  id: "pipeline",
  provider: "salesforce",
  kind: "soql",
  query: PINNED_QUERY,
  label: "Closed won pipeline",
};
const genericBinding = {
  id: "pipeline",
  provider: "salesforce",
  toolName: "run_soql",
  pinnedArgs: { soql: PINNED_QUERY },
  label: "Closed won pipeline",
};
const PUBLIC_BINDING = {
  id: "pipeline",
  provider: "salesforce",
  toolName: "run_soql",
  label: "Closed won pipeline",
};
const githubBinding = {
  id: "open-issues",
  provider: "github",
  toolName: "list_issues",
  pinnedArgs: GITHUB_PINNED_ARGS,
  label: "Open triage",
};
const appHtml =
  "<!doctype html><html><head><title>Pipeline</title></head><body>" +
  "<h1>Pipeline</h1><script>window.comparativeData.refresh('pipeline');</script>" +
  "</body></html>";

function oauthTokenRow(userId: string, provider = "salesforce", accessToken = STORED_CIPHERTEXT) {
  return {
    userId,
    provider,
    accessToken,
    refreshToken: STORED_CIPHERTEXT,
    expiresAt: null,
    revokedAt: null,
  };
}

function attestationRow(userId: string, provider: string) {
  return {
    userId,
    provider,
    scopeType: "provider",
    category: null,
    toolCatalogId: null,
    toolName: null,
    action: "read",
    revokedAt: null,
  };
}

function catalogRow(
  provider: string,
  toolName: string,
  action: "read" | "write" = "read",
) {
  return {
    id: `cat-${provider}-${toolName}`,
    provider,
    toolName,
    category: "data",
    action,
    policy: action === "read" ? "always_allow" : "needs_approval",
    requiresAttestation: false,
    enabled: true,
  };
}

// The viewer's world: a Salesforce grant, a provider-level read attestation,
// the org connector registry row, and the catalog row that classifies
// run_soql as an enabled always-allowed READ tool. Rows are stored in the
// projected shape the real selects return (the fake filters, not projects).
function seedTables() {
  rowsByTable.clear();
  rowsByTable.set(schema.oauthTokens, [oauthTokenRow(viewer.id)]);
  rowsByTable.set(schema.userToolAttestations, [
    attestationRow(viewer.id, "salesforce"),
  ]);
  rowsByTable.set(schema.mcpServers, [{ slug: "salesforce", status: "active" }]);
  rowsByTable.set(schema.toolsCatalog, [catalogRow("salesforce", "run_soql")]);
  rowsByTable.set(schema.appVersionDataBindings, [
    { appVersionId: "version-live", ...genericBinding },
  ]);
}

async function liveArtifact(dataBindings: unknown[] = [legacyBinding]) {
  const { createAppPublicationMetadata, stampAppPublicationMetadata } =
    await import("@/lib/app-publication");
  const bindings = { dataBindings };
  return {
    id: "artifact-live",
    content: appHtml,
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    metadata: stampAppPublicationMetadata(
      bindings,
      createAppPublicationMetadata({
        artifactMetadata: bindings,
        dataMode: "live_via_viewer",
        publishedAt: new Date("2026-09-01T00:00:00Z"),
        publishedByUserId: appRow.ownerUserId,
        audience: "named",
      }),
    ),
  };
}

async function snapshotArtifact() {
  const { createAppPublicationMetadata, stampAppPublicationMetadata } =
    await import("@/lib/app-publication");
  return {
    id: "artifact-live",
    content: appHtml,
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    metadata: stampAppPublicationMetadata(
      {},
      createAppPublicationMetadata({
        artifactMetadata: {},
        dataMode: "snapshot",
        publishedAt: new Date("2026-09-01T00:00:00Z"),
        publishedByUserId: appRow.ownerUserId,
        audience: "named",
      }),
    ),
  };
}

async function serveApp() {
  rowsByTable.set(schema.apps, [{ app: appRow, ownerName: "Author" }]);
  const { GET } = await import("@/app/apps/[slug]/route");
  return GET(new Request("https://c.example/apps/pipeline"), {
    params: Promise.resolve({ slug: "pipeline" }),
  });
}

async function fetchBinding(bindingId = "pipeline") {
  rowsByTable.set(schema.apps, [appRow]);
  const { GET } = await import("@/app/api/apps/[id]/data/[bindingId]/route");
  return GET(new Request(`https://c.example/api/apps/app-1/data/${bindingId}`), {
    params: Promise.resolve({ id: "app-1", bindingId }),
  });
}

function tokenLookups() {
  return queries.filter((query) => query.table === "oauth_tokens");
}

/** Every token-store lookup so far was keyed by the viewer, never the author. */
function expectViewerScopedTokenLookups() {
  expect(tokenLookups().length).toBeGreaterThan(0);
  for (const lookup of tokenLookups()) {
    expect(lookup.where.userId).toEqual([viewer.id]);
  }
}

function parseCsp(header: string | null): Record<string, string[]> {
  const directives: Record<string, string[]> = {};
  for (const directive of (header ?? "").split(";")) {
    const [name, ...values] = directive.trim().split(/\s+/);
    if (name) directives[name] = values;
  }
  return directives;
}

function expectNoCredentialMaterial(text: string, label: string) {
  expect(findTokenShapedContent(text), label).toEqual([]);
  expect(text, label).not.toContain(VIEWER_TOKEN);
  expect(text, label).not.toContain(STORED_CIPHERTEXT);
  expect(text, label).not.toContain(GITHUB_TOKEN);
  expect(text, label).not.toContain(INSTANCE_URL);
  expect(text, label).not.toContain("pinnedArgs");
  for (const fragment of [...QUERY_FRAGMENTS, ...Object.values(GITHUB_PINNED_ARGS)]) {
    expect(text, label).not.toContain(fragment);
  }
}

function expectSandboxCsp(csp: Record<string, string[]>) {
  expect(csp["default-src"]).toEqual(["'none'"]);
  expect(csp["form-action"]).toEqual(["'none'"]);
  expect(csp["base-uri"]).toEqual(["'none'"]);
  expect(csp["frame-ancestors"]).toEqual(["'self'"]);
  // No frame-src directive: nested browsing contexts fall back to
  // default-src 'none', so the page cannot frame a provider either.
  expect(csp["frame-src"]).toBeUndefined();
  for (const [name, values] of Object.entries(csp)) {
    for (const value of values) {
      expect(value, `${name} ${value}`).not.toContain("*");
      expect(value, `${name} ${value}`).not.toMatch(/^https?:/);
      for (const host of PROVIDER_HOSTS) {
        expect(value, `${name} ${value}`).not.toContain(host);
      }
    }
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  queries.length = 0;
  seedTables();
  getSessionUser.mockResolvedValue(viewer);
  canActorOpenApp.mockResolvedValue(true);
  auditAdminDataAccess.mockResolvedValue("skipped");
  checkRateLimit.mockResolvedValue({
    allowed: true,
    limit: 30,
    remaining: 29,
    resetAt: new Date("2026-09-05T00:00:00Z"),
    retryAfterSeconds: 60,
  });
  getLiveAppVersion.mockResolvedValue({
    id: "version-live",
    artifactId: "artifact-live",
    deployedAt: new Date("2026-09-01T00:00:00Z"),
  });
  loadWorkspaceArtifactById.mockResolvedValue(await liveArtifact());
  resolveSalesforceConnection.mockResolvedValue({
    status: "ready",
    connected: true,
    ready: true,
    accessToken: VIEWER_TOKEN,
    instanceUrl: INSTANCE_URL,
    grantedScopes: ["api", "refresh_token"],
    expiresAt: new Date("2026-09-05T00:25:00Z"),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("token-handler discipline for deployed apps (#807)", () => {
  it("serves a live-data app document that carries binding ids only", async () => {
    const res = await serveApp();
    expect(res.status).toBe(200);
    const html = await res.text();

    expectNoCredentialMaterial(html, "app document");
    // The injected bootstrap is the allowlisted public view of the binding —
    // id, provider, tool, label — resolved from the LIVE version's pinned rows.
    expect(html).toContain(`"bindings":[${JSON.stringify(PUBLIC_BINDING)}]`);
    expect(html).toContain("/api/apps/' + app.appId + '/data/'");
    expect(queries).toContainEqual({
      table: "app_version_data_bindings",
      where: { appVersionId: ["version-live"] },
    });
    // Rendering the document never touches the token store or resolves the
    // viewer's token.
    expect(tokenLookups()).toEqual([]);
    expect(resolveSalesforceConnection).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("confines a live-data app to same-origin fetch and nothing else", async () => {
    const res = await serveApp();
    const csp = parseCsp(res.headers.get("content-security-policy"));

    expectSandboxCsp(csp);
    // The one relaxation (#407): the page may call its own data endpoint.
    expect(csp["connect-src"]).toEqual(["'self'"]);
  });

  it("keeps a snapshot app fully closed — no network at all", async () => {
    loadWorkspaceArtifactById.mockResolvedValue(await snapshotArtifact());
    const res = await serveApp();
    const csp = parseCsp(res.headers.get("content-security-policy"));

    expectSandboxCsp(csp);
    expect(csp["connect-src"]).toEqual(["'none'"]);
    expect(await res.text()).not.toContain("__COMPARATIVE_APP__");
  });

  it("returns rows only from the binding endpoint; the token leaves the server toward the provider alone", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            totalSize: 1,
            done: true,
            records: [{ attributes: { type: "Opportunity" }, Id: "006xx0000012345AAA" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchBinding();
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(JSON.parse(bodyText)).toMatchObject({
      ok: true,
      bindingId: "pipeline",
      provider: "salesforce",
      toolName: "run_soql",
      records: [{ Id: "006xx0000012345AAA" }],
      data: { records: [{ Id: "006xx0000012345AAA" }] },
    });
    expectNoCredentialMaterial(bodyText, "binding response");
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    // Viewer-scoped token resolution: every token-store lookup and every
    // connection resolution is keyed by the VIEWER's id, never the author's.
    expectViewerScopedTokenLookups();
    expect(resolveSalesforceConnection).toHaveBeenCalledWith(
      expect.anything(),
      viewer.id,
    );
    expect(resolveSalesforceConnection).not.toHaveBeenCalledWith(
      expect.anything(),
      appRow.ownerUserId,
    );

    // The only outbound use of the token: an Authorization header on the
    // server-side request to the viewer's own Salesforce instance.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url.startsWith(`${INSTANCE_URL}/services/data/`)).toBe(true);
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${VIEWER_TOKEN}`,
    );
    expect(connectMcpTools).not.toHaveBeenCalled();
    // The audit rows written along the way carry no token material either —
    // binding id, provider, tool, row count; never the pinned arguments.
    expect(auditAppMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "app_data_refresh",
        status: "succeeded",
        actorUserId: viewer.id,
        metadata: { bindingId: "pipeline", provider: "salesforce", toolName: "run_soql", rowCount: 1 },
      }),
    );
    expectNoCredentialMaterial(
      JSON.stringify(auditAppMutation.mock.calls),
      "audit rows",
    );
  });

  it("mounts a generic read tool for the viewer alone; the token rides only in the Authorization header to the provider's fixed MCP endpoint", async () => {
    vi.stubEnv("OAUTH_ENCRYPTION_KEY", Buffer.alloc(32, 8).toString("base64"));
    const { encryptSecret } = await import("@/lib/oauth/crypto");
    // The viewer holds both grants; the author holds a GitHub grant too.
    rowsByTable.set(schema.oauthTokens, [
      oauthTokenRow(viewer.id),
      oauthTokenRow(viewer.id, "github", encryptSecret(GITHUB_TOKEN)),
      oauthTokenRow(appRow.ownerUserId, "github", encryptSecret("ghp_author_token_never_used_000000")),
    ]);
    rowsByTable.set(schema.userToolAttestations, [
      attestationRow(viewer.id, "salesforce"),
      attestationRow(viewer.id, "github"),
    ]);
    rowsByTable.set(schema.mcpServers, [
      { slug: "salesforce", status: "active" },
      { slug: "github", status: "active" },
    ]);
    rowsByTable.set(schema.toolsCatalog, [
      catalogRow("salesforce", "run_soql"),
      catalogRow("github", "list_issues"),
      catalogRow("github", "create_issue", "write"),
    ]);
    rowsByTable.set(schema.appVersionDataBindings, [
      { appVersionId: "version-live", ...githubBinding },
    ]);
    loadWorkspaceArtifactById.mockResolvedValue(await liveArtifact([githubBinding]));
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);

    // The MCP client seam: tools carry the policy the mount spec declares,
    // exactly as connectMcpTools derives it from the spec.
    const listIssues = vi.fn(async () => ({
      issues: [{ number: 802, title: "Generic read bindings" }],
    }));
    const close = vi.fn(async () => undefined);
    let mounted: Record<string, { url: string; headers: Record<string, string> }> = {};
    connectMcpTools.mockImplementation(
      async (
        servers: Record<
          string,
          {
            url: string;
            headers: Record<string, string>;
            toolPolicies?: Record<string, string>;
            defaultToolPolicy?: string;
          }
        >,
      ) => {
        mounted = servers;
        const spec = servers.github!;
        const tool = (name: string, handler: unknown) => ({
          name: `github__${name}`,
          policy: spec.toolPolicies?.[name] ?? spec.defaultToolPolicy,
          handler,
        });
        return {
          tools: [tool("list_issues", listIssues), tool("create_issue", vi.fn())],
          providers: { github: 2 },
          failedProviders: [],
          close,
        };
      },
    );

    // The served document names the binding, not its arguments.
    const html = await (await serveApp()).text();
    expectNoCredentialMaterial(html, "app document");
    expect(html).toContain(
      `"bindings":[${JSON.stringify({ id: "open-issues", provider: "github", toolName: "list_issues", label: "Open triage" })}]`,
    );

    const res = await fetchBinding("open-issues");
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(JSON.parse(bodyText)).toEqual({
      ok: true,
      bindingId: "open-issues",
      provider: "github",
      toolName: "list_issues",
      data: { issues: [{ number: 802, title: "Generic read bindings" }] },
    });
    expectNoCredentialMaterial(bodyText, "binding response");
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    // Only this provider is mounted, for the VIEWER, against the fixed
    // endpoint — the decrypted token appears once, in the Authorization
    // header, and nowhere else in the mount spec.
    expectViewerScopedTokenLookups();
    expect(connectMcpTools).toHaveBeenCalledTimes(1);
    expect(connectMcpTools).toHaveBeenCalledWith(mounted, {
      clientName: "comparative-app-data",
    });
    expect(Object.keys(mounted)).toEqual(["github"]);
    expect(mounted.github!.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(mounted.github!.headers).toEqual({
      Authorization: `Bearer ${GITHUB_TOKEN}`,
    });
    expect(JSON.stringify({ ...mounted.github, headers: undefined })).not.toContain(
      GITHUB_TOKEN,
    );
    expect(JSON.stringify(mounted)).not.toContain("ghp_author_token");
    // The pinned arguments reach the tool, as the viewer, and nothing else.
    expect(listIssues).toHaveBeenCalledWith(GITHUB_PINNED_ARGS, { userId: viewer.id });
    expect(close).toHaveBeenCalled();
    // No direct provider call, and the Salesforce path stays out of it.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveSalesforceConnection).not.toHaveBeenCalled();
    expect(auditAppMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "app_data_refresh",
        status: "succeeded",
        actorUserId: viewer.id,
        metadata: { bindingId: "open-issues", provider: "github", toolName: "list_issues" },
      }),
    );
    expectNoCredentialMaterial(
      JSON.stringify(auditAppMutation.mock.calls),
      "audit rows",
    );
  });

  it("keeps connect-prompt and upstream-failure responses free of credential material", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);

    // The viewer's grant needs renewing: an honest connect state, no fetch.
    resolveSalesforceConnection.mockResolvedValueOnce({
      status: "reconnect_required",
      connected: true,
      ready: false,
      reason: "expired_grant",
      grantedScopes: ["api", "refresh_token"],
    });
    const prompt = await fetchBinding();
    expect(prompt.status).toBe(200);
    const promptText = await prompt.text();
    expect(JSON.parse(promptText)).toEqual({
      ok: false,
      needsConnection: true,
      provider: "salesforce",
      connectionStatus: "reconnect_required",
    });
    expectNoCredentialMaterial(promptText, "connect prompt");
    expect(fetchMock).not.toHaveBeenCalled();

    // Only the AUTHOR holds a grant: the viewer gets a connect prompt, never
    // the author's rows, and the author's token is never even resolved.
    rowsByTable.set(schema.oauthTokens, [oauthTokenRow(appRow.ownerUserId)]);
    resolveSalesforceConnection.mockClear();
    const unconnected = await fetchBinding();
    expect(unconnected.status).toBe(200);
    const unconnectedText = await unconnected.text();
    expect(JSON.parse(unconnectedText)).toEqual({
      ok: false,
      needsConnection: true,
      provider: "salesforce",
      connectionStatus: "not_connected",
    });
    expectNoCredentialMaterial(unconnectedText, "unconnected prompt");
    expectViewerScopedTokenLookups();
    expect(resolveSalesforceConnection).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    rowsByTable.set(schema.oauthTokens, [oauthTokenRow(viewer.id)]);

    // Salesforce rejects the session: the 502 must not echo the upstream
    // body, the token, or the instance — and the audit row keeps only a
    // status category.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          { message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" },
        ]),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );
    const failure = await fetchBinding();
    expect(failure.status).toBe(502);
    const failureText = await failure.text();
    expect(JSON.parse(failureText)).toEqual({
      ok: false,
      error: "data_source_error",
      message: "The data source could not be reached.",
    });
    expectNoCredentialMaterial(failureText, "upstream failure");
    expect(failureText).not.toContain("INVALID_SESSION_ID");
    expect(auditAppMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "app_data_refresh",
        status: "failed",
        error: "salesforce_error_401",
      }),
    );
    const auditText = JSON.stringify(auditAppMutation.mock.calls);
    expectNoCredentialMaterial(auditText, "audit rows");
    expect(auditText).not.toContain("INVALID_SESSION_ID");
  });

  it("strips the pinned query from every serialized artifact metadata view", async () => {
    // workspace-artifacts.ts routes every client-bound artifact through
    // scrubBindingsForClient (normalizeMetadata); this is that contract, for
    // both stored shapes: the legacy #407 `query` and the generic #802
    // `pinnedArgs` collapse to the same allowlisted public binding.
    const { scrubBindingsForClient } = await import("@/lib/app-data-bindings");
    const artifact = await liveArtifact();
    const legacy = JSON.stringify(scrubBindingsForClient(artifact.metadata));
    expectNoCredentialMaterial(legacy, "artifact metadata (legacy shape)");
    expect(legacy).not.toContain('"query"');
    expect(JSON.parse(legacy).dataBindings).toEqual([PUBLIC_BINDING]);

    const generic = JSON.stringify(
      scrubBindingsForClient({
        ...artifact.metadata,
        dataBindings: [genericBinding],
      }),
    );
    expectNoCredentialMaterial(generic, "artifact metadata (generic shape)");
    expect(JSON.parse(generic).dataBindings).toEqual([PUBLIC_BINDING]);
  });
});
