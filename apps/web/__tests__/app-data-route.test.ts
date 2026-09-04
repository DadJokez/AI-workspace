import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route composes library functions; mocking them (rather than replaying a
// DB select-queue) makes the per-viewer scoping assertion the center of the
// test: the binding executes for the VIEWER, never the author, and only when
// the live version declares it.

const getSessionUser = vi.fn();
const canActorOpenApp = vi.fn();
const getLiveAppVersion = vi.fn();
const auditAppMutation = vi.fn();
const auditAdminDataAccess = vi.fn();
const loadWorkspaceArtifactById = vi.fn();
const loadAppVersionDataBindings = vi.fn();
const executeAppDataBinding = vi.fn();
const checkRateLimit = vi.fn();
const resolveAppPublication = vi.fn();
const isBindingIncludedInPublication = vi.fn();
const isPublicationManifestEnabled = vi.fn();

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
vi.mock("@/lib/app-data-execution", () => ({ executeAppDataBinding }));
vi.mock("@/lib/request-limits", () => ({ checkRateLimit }));
vi.mock("@/lib/app-publication", () => ({
  resolveAppPublication,
  isBindingIncludedInPublication,
  isPublicationManifestEnabled,
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
  toolName: "run_soql",
  pinnedArgs: { soql: "SELECT Id FROM Opportunity LIMIT 10" },
};

async function callRoute(bindingId = "pipeline") {
  const { GET } = await import(
    "@/app/api/apps/[id]/data/[bindingId]/route"
  );
  return GET(new Request(`https://c.example/api/apps/app-1/data/${bindingId}`), {
    params: Promise.resolve({ id: "app-1", bindingId }),
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
  getLiveAppVersion.mockResolvedValue({
    id: "version-live",
    artifactId: "artifact-live",
  });
  loadWorkspaceArtifactById.mockResolvedValue({
    id: "artifact-live",
    metadata: { dataBindings: [binding] },
  });
  loadAppVersionDataBindings.mockResolvedValue([binding]);
  executeAppDataBinding.mockResolvedValue({
    kind: "ok",
    data: { records: [{ Id: "006xxx" }], totalSize: 1, done: true },
    rowCount: 1,
    legacyFields: { records: [{ Id: "006xxx" }], totalSize: 1, done: true },
  });
  resolveAppPublication.mockReturnValue({
    metadata: {
      dataMode: "live_via_viewer",
      connectorManifest: [
        {
          provider: "salesforce",
          toolName: "run_soql",
          catalogKey: "salesforce:run_soql",
          bindingIds: ["pipeline"],
        },
      ],
    },
  });
  isBindingIncludedInPublication.mockReturnValue(true);
  isPublicationManifestEnabled.mockResolvedValue(true);
  auditAdminDataAccess.mockResolvedValue("skipped");
});

afterEach(() => vi.resetModules());

describe("GET /api/apps/[id]/data/[bindingId]", () => {
  it("does not expose a binding endpoint for a snapshot publication", async () => {
    resolveAppPublication.mockReturnValueOnce({
      metadata: { dataMode: "snapshot", connectorManifest: [] },
    });

    const res = await callRoute();

    expect(res.status).toBe(404);
    expect(executeAppDataBinding).not.toHaveBeenCalled();
  });

  it("does not expose a binding omitted from the published manifest", async () => {
    isBindingIncludedInPublication.mockReturnValueOnce(false);

    const res = await callRoute();

    expect(res.status).toBe(404);
    expect(executeAppDataBinding).not.toHaveBeenCalled();
  });

  it("404s when a manifest tool is no longer an enabled read tool", async () => {
    isPublicationManifestEnabled.mockResolvedValueOnce(false);

    const res = await callRoute();

    expect(res.status).toBe(404);
    expect(executeAppDataBinding).not.toHaveBeenCalled();
  });

  it("resolves the binding from the LIVE version's pinned declarations and executes as the viewer", async () => {
    const res = await callRoute();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      bindingId: "pipeline",
      provider: "salesforce",
      toolName: "run_soql",
      records: [{ Id: "006xxx" }],
      data: { records: [{ Id: "006xxx" }] },
    });

    // Declaration enforcement: bindings come from the live version's pins.
    expect(loadAppVersionDataBindings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appVersionId: "version-live" }),
    );
    // The scoping spine: execution is for the VIEWER, not the author.
    expect(executeAppDataBinding).toHaveBeenCalledWith(
      expect.objectContaining({ viewerUserId: viewer.id, binding }),
    );
    expect(executeAppDataBinding).not.toHaveBeenCalledWith(
      expect.objectContaining({ viewerUserId: appRow.ownerUserId }),
    );
    // The response never carries the pinned arguments.
    expect(JSON.stringify(body)).not.toContain("SELECT Id FROM Opportunity");
    expect(auditAppMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "app_data_refresh",
        status: "succeeded",
        actorUserId: viewer.id,
        metadata: expect.objectContaining({
          bindingId: "pipeline",
          provider: "salesforce",
          toolName: "run_soql",
          rowCount: 1,
        }),
      }),
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
    expect(executeAppDataBinding).not.toHaveBeenCalled();
  });

  it("404s (not 403) and audits a denial when the viewer cannot open the app", async () => {
    canActorOpenApp.mockResolvedValue(false);
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(executeAppDataBinding).not.toHaveBeenCalled();
    expect(auditAppMutation).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: "app_data_denied", status: "denied" }),
    );
  });

  it("returns an honest connect prompt (never data) when the viewer has no connection", async () => {
    executeAppDataBinding.mockResolvedValue({
      kind: "needs_connection",
      connectionStatus: "not_connected",
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
    expect(auditAppMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "app_data_refresh",
        metadata: expect.objectContaining({ outcome: "connection_not_connected" }),
      }),
    );
  });

  it("404s an unknown binding id", async () => {
    const res = await callRoute("missing");
    expect(res.status).toBe(404);
    expect(executeAppDataBinding).not.toHaveBeenCalled();
  });

  it("422s a pinned binding whose arguments fail read-only re-validation", async () => {
    executeAppDataBinding.mockResolvedValue({ kind: "invalid_binding" });
    const res = await callRoute();
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid_binding" });
  });

  it("404s and audits a policy denial", async () => {
    executeAppDataBinding.mockResolvedValue({
      kind: "denied",
      reason: "tool_policy_not_always_allow",
    });
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(auditAppMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "app_data_denied",
        status: "denied",
        error: "tool_policy_not_always_allow",
      }),
    );
  });

  it("502s a source error with only a category in the audit row", async () => {
    executeAppDataBinding.mockResolvedValue({
      kind: "source_error",
      category: "salesforce_error_400",
    });
    const res = await callRoute();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      ok: false,
      error: "data_source_error",
      message: "The data source could not be reached.",
    });
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
    expect(executeAppDataBinding).not.toHaveBeenCalled();
  });
});
