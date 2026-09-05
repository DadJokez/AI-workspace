import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findTokenShapedContent } from "./helpers/token-shapes";

/**
 * Token-handler discipline for deployed apps (#807). A connected viewer opens
 * a live-data app and refreshes a binding; everything the browser can see —
 * the served document, the binding data response, the connect/error
 * responses, the serialized artifact metadata — is scanned for credential
 * shapes, and the viewer's token is shown to leave the server toward the
 * provider only. The scoping spine (viewer's token, never the author's) is
 * covered by app-data-route.test.ts; this file is about *where the token can
 * go*.
 *
 * Only the seams that touch the database or the session are faked; the
 * bootstrap injection, publication resolution, SOQL client, and CSP are the
 * real modules.
 */

const getSessionUser = vi.fn();
const canActorOpenApp = vi.fn();
const getLiveAppVersion = vi.fn();
const auditAppMutation = vi.fn();
const auditAdminDataAccess = vi.fn();
const loadWorkspaceArtifactById = vi.fn();
const checkRateLimit = vi.fn();
const resolveSalesforceConnection = vi.fn();

let dbRows: unknown[] = [];
const dbChain = {
  from: () => dbChain,
  innerJoin: () => dbChain,
  where: () => dbChain,
  limit: async () => dbRows,
};

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
vi.mock("@ai-workspace/db", () => ({
  apps: {},
  users: {},
  toolsCatalog: {},
  getDb: () => ({ select: () => dbChain }),
}));
vi.mock("@/lib/app-publication", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-publication")>();
  return { ...actual, isPublicationManifestEnabled: vi.fn(async () => true) };
});

// A realistic Salesforce session id (fixture — not a real credential) and a
// pinned query whose fragments must never reach the viewer.
const VIEWER_TOKEN =
  "00D5g000004YzABEA2!AQEAQOx1kJ8xxg8s5m1VJ8xxg8s5m1VJ8xxg8s5m1VJ8xxg8s5m1VJ8xxg8s5m1V";
const INSTANCE_URL = "https://viewer-org.my.salesforce.com";
const PINNED_QUERY =
  "SELECT Id, Name, Secret_Margin__c FROM Opportunity WHERE StageName = 'Closed Won' LIMIT 25";
const QUERY_FRAGMENTS = ["Secret_Margin__c", "StageName", "Closed Won"];
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
const binding = {
  id: "pipeline",
  provider: "salesforce",
  kind: "soql",
  query: PINNED_QUERY,
  label: "Closed won pipeline",
};
const appHtml =
  "<!doctype html><html><head><title>Pipeline</title></head><body>" +
  "<h1>Pipeline</h1><script>window.comparativeData.refresh('pipeline');</script>" +
  "</body></html>";

async function liveArtifact() {
  const { createAppPublicationMetadata, stampAppPublicationMetadata } =
    await import("@/lib/app-publication");
  const bindings = { dataBindings: [binding] };
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
  dbRows = [{ app: appRow, ownerName: "Author" }];
  const { GET } = await import("@/app/apps/[slug]/route");
  return GET(new Request("https://c.example/apps/pipeline"), {
    params: Promise.resolve({ slug: "pipeline" }),
  });
}

async function fetchBinding() {
  dbRows = [appRow];
  const { GET } = await import("@/app/api/apps/[id]/data/[bindingId]/route");
  return GET(new Request("https://c.example/api/apps/app-1/data/pipeline"), {
    params: Promise.resolve({ id: "app-1", bindingId: "pipeline" }),
  });
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
  expect(text, label).not.toContain(INSTANCE_URL);
  for (const fragment of QUERY_FRAGMENTS) {
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
  vi.resetModules();
});

describe("token-handler discipline for deployed apps (#807)", () => {
  it("serves a live-data app document that carries binding ids only", async () => {
    const res = await serveApp();
    expect(res.status).toBe(200);
    const html = await res.text();

    expectNoCredentialMaterial(html, "app document");
    // The injected bootstrap is the allowlisted public view of the binding.
    expect(html).toContain(
      '"bindings":[{"id":"pipeline","provider":"salesforce","kind":"soql","label":"Closed won pipeline"}]',
    );
    expect(html).toContain("/api/apps/' + app.appId + '/data/'");
    // Rendering the document never even resolves the viewer's token.
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
      records: [{ Id: "006xx0000012345AAA" }],
    });
    expectNoCredentialMaterial(bodyText, "binding response");
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    // The only outbound use of the token: an Authorization header on the
    // server-side request to the viewer's own Salesforce instance.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url.startsWith(`${INSTANCE_URL}/services/data/`)).toBe(true);
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${VIEWER_TOKEN}`,
    );
    // The audit rows written along the way carry no token material either.
    expectNoCredentialMaterial(
      JSON.stringify(auditAppMutation.mock.calls),
      "audit rows",
    );
  });

  it("keeps connect-prompt and upstream-failure responses free of credential material", async () => {
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

    // Salesforce rejects the session: the 502 must not echo the upstream
    // body, the token, or the instance.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              { message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" },
            ]),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
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
  });

  it("strips the pinned query from every serialized artifact metadata view", async () => {
    // workspace-artifacts.ts routes every client-bound artifact through
    // scrubBindingsForClient (normalizeMetadata); this is that contract.
    const { scrubBindingsForClient } = await import("@/lib/app-data-bindings");
    const artifact = await liveArtifact();
    const serialized = JSON.stringify(scrubBindingsForClient(artifact.metadata));

    expectNoCredentialMaterial(serialized, "artifact metadata");
    expect(JSON.parse(serialized).dataBindings).toEqual([
      { id: "pipeline", provider: "salesforce", kind: "soql", label: "Closed won pipeline" },
    ]);
  });
});
