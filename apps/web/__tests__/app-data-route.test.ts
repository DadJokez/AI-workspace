import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route composes library functions; mocking them (rather than replaying a
// DB select-queue) makes the per-viewer scoping assertion the center of the
// test: the query runs under the VIEWER's connection, never the author's.

const getSessionUser = vi.fn();
const canActorOpenApp = vi.fn();
const getLiveAppVersion = vi.fn();
const auditAppMutation = vi.fn();
const auditAdminDataAccess = vi.fn();
const loadWorkspaceArtifactById = vi.fn();
const checkRateLimit = vi.fn();
const resolveSalesforceConnection = vi.fn();
const queryReadOnlySoql = vi.fn();

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
const binding = {
  id: "pipeline",
  provider: "salesforce",
  kind: "soql",
  query: "SELECT Id FROM Opportunity LIMIT 10",
};

async function callRoute() {
  const { GET } = await import(
    "@/app/api/apps/[id]/data/[bindingId]/route"
  );
  return GET(new Request("https://c.example/api/apps/app-1/data/pipeline"), {
    params: Promise.resolve({ id: "app-1", bindingId: "pipeline" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionUser.mockResolvedValue(viewer);
  canActorOpenApp.mockResolvedValue(true);
  checkRateLimit.mockResolvedValue({
    allowed: true,
    limit: 30,
    remaining: 29,
    resetAt: new Date("2026-07-18T00:00:00Z"),
    retryAfterSeconds: 60,
  });
  getLiveAppVersion.mockResolvedValue({ artifactId: "artifact-live" });
  loadWorkspaceArtifactById.mockResolvedValue({
    id: "artifact-live",
    metadata: { dataBindings: [binding] },
  });
  resolveSalesforceConnection.mockResolvedValue({
    status: "ready",
    ready: true,
    accessToken: "viewer-token",
    instanceUrl: "https://na1.salesforce.com",
  });
  queryReadOnlySoql.mockResolvedValue({
    soql: binding.query,
    totalSize: 1,
    done: true,
    records: [{ Id: "006xxx" }],
  });
  auditAdminDataAccess.mockResolvedValue("skipped");
});

afterEach(() => vi.resetModules());

describe("GET /api/apps/[id]/data/[bindingId]", () => {
  it("runs the pinned query under the VIEWER's own connection and returns rows", async () => {
    const res = await callRoute();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, records: [{ Id: "006xxx" }] });

    // The scoping spine: the token resolves for the VIEWER, not the author.
    expect(resolveSalesforceConnection).toHaveBeenCalledWith(
      expect.anything(),
      viewer.id,
    );
    expect(resolveSalesforceConnection).not.toHaveBeenCalledWith(
      expect.anything(),
      appRow.ownerUserId,
    );
    // The token passed to execution is the viewer's.
    expect(queryReadOnlySoql).toHaveBeenCalledWith(
      binding.query,
      expect.objectContaining({ accessToken: "viewer-token" }),
    );
  });

  it("records an admin opening another user's app data surface", async () => {
    const admin = {
      id: "admin-1",
      email: "admin@x.com",
      displayName: "Admin",
      role: "admin",
    };
    getSessionUser.mockResolvedValue(admin);

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(auditAdminDataAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: admin,
        access: expect.objectContaining({
          targetUserId: appRow.ownerUserId,
          resourceType: "app",
          resourceId: appRow.id,
          surface: "app_data",
        }),
      }),
    );
  });

  it("401s an unauthenticated request before touching data", async () => {
    getSessionUser.mockResolvedValue(null);
    const res = await callRoute();
    expect(res.status).toBe(401);
    expect(resolveSalesforceConnection).not.toHaveBeenCalled();
  });

  it("404s (not 403) and audits a denial when the viewer cannot open the app", async () => {
    canActorOpenApp.mockResolvedValue(false);
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(queryReadOnlySoql).not.toHaveBeenCalled();
    expect(auditAppMutation).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: "app_data_denied", status: "denied" }),
    );
  });

  it("returns an honest connect prompt (never data) when the viewer has no connection", async () => {
    resolveSalesforceConnection.mockResolvedValue({
      status: "not_connected",
      ready: false,
    });
    const res = await callRoute();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: false,
      needsConnection: true,
      provider: "salesforce",
      connectionStatus: "not_connected",
    });
    expect(queryReadOnlySoql).not.toHaveBeenCalled();
  });

  it("404s an unknown binding id", async () => {
    loadWorkspaceArtifactById.mockResolvedValue({
      id: "artifact-live",
      metadata: { dataBindings: [] },
    });
    const res = await callRoute();
    expect(res.status).toBe(404);
  });

  it("422s and never executes a pinned query that fails read-only re-validation", async () => {
    loadWorkspaceArtifactById.mockResolvedValue({
      id: "artifact-live",
      metadata: {
        dataBindings: [
          { ...binding, query: "UPDATE Opportunity SET Name='x'" },
        ],
      },
    });
    const res = await callRoute();
    expect(res.status).toBe(422);
    expect(queryReadOnlySoql).not.toHaveBeenCalled();
    expect(resolveSalesforceConnection).not.toHaveBeenCalled();
  });

  it("never echoes the pinned query in the 502 body or audit row (Salesforce echoes queries in errors)", async () => {
    const secretQuery =
      "SELECT Id, Secret_Margin__c FROM Opportunity WHERE StageName='Closed Won'";
    loadWorkspaceArtifactById.mockResolvedValue({
      id: "artifact-live",
      metadata: { dataBindings: [{ ...binding, query: secretQuery }] },
    });
    // Salesforce INVALID_FIELD errors quote the submitted query verbatim.
    queryReadOnlySoql.mockRejectedValue(
      new SalesforceApiError(
        400,
        `${secretQuery}\n^ ERROR at Row:1:Column:12 No such column 'Secret_Margin__c' (INVALID_FIELD)`,
      ),
    );

    const res = await callRoute();
    expect(res.status).toBe(502);
    const bodyText = JSON.stringify(await res.json());
    for (const fragment of ["Secret_Margin__c", "StageName", "Closed Won"]) {
      expect(bodyText).not.toContain(fragment);
    }
    const auditText = JSON.stringify(auditAppMutation.mock.calls);
    for (const fragment of ["Secret_Margin__c", "StageName", "Closed Won"]) {
      expect(auditText).not.toContain(fragment);
    }
    // The audit still records a useful, non-echoing category.
    expect(auditAppMutation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error: "salesforce_error_400" }),
    );
  });

  it("429s when the per-viewer rate limit is exceeded", async () => {
    checkRateLimit.mockResolvedValue({
      allowed: false,
      limit: 30,
      remaining: 0,
      resetAt: new Date("2026-07-18T00:00:00Z"),
      retryAfterSeconds: 42,
    });
    const res = await callRoute();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(queryReadOnlySoql).not.toHaveBeenCalled();
  });
});
