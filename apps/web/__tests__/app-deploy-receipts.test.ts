import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [
          {
            id: "app-1",
            ownerUserId: "user-1",
            name: "Dashboard",
            slug: "dashboard",
            sourceThreadId: "thread-1",
            archivedAt: null,
          },
        ],
      }),
    }),
  }),
};

const version = {
  id: "version-4",
  appId: "app-1",
  artifactId: "artifact-1",
  versionNumber: 4,
  status: "draft",
};

const artifact = {
  id: "artifact-1",
  runId: "run-1",
  threadId: "thread-1",
  filename: "dashboard.html",
  content: "<!doctype html><h1>Dashboard</h1>",
};

const appendRunEventBestEffort = vi.fn(async () => undefined);
const auditAppMutation = vi.fn(async () => undefined);
const deployAppVersion = vi.fn(async () => ({ id: "app-1", status: "deployed" }));
const scanArtifactForSecrets = vi.fn((): string[] => []);

function installMocks() {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => ({
      id: "user-1",
      email: "owner@example.com",
      displayName: "Owner",
      role: "user",
    }),
  }));
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    return { ...actual, getDb: () => db as never };
  });
  vi.doMock("@/lib/apps", () => ({
    auditAppMutation,
    canAppRoleDeploy: () => true,
    createAppVersionForArtifact: vi.fn(),
    deployAppVersion,
    scanArtifactForSecrets,
    isServableArtifact: () => true,
    loadAppVersion: async () => version,
    resolveAppActorRole: async () => "owner",
  }));
  vi.doMock("@/lib/workspace-artifacts", () => ({
    loadWorkspaceArtifactById: async () => artifact,
    loadWorkspaceArtifactForUser: vi.fn(),
  }));
  vi.doMock("@/lib/run-events", () => ({ appendRunEventBestEffort }));
}

function request() {
  return new Request("http://localhost/api/apps/app-1/deploy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appVersionId: version.id }),
  });
}

beforeEach(() => {
  vi.resetModules();
  appendRunEventBestEffort.mockClear();
  auditAppMutation.mockClear();
  deployAppVersion.mockClear();
  scanArtifactForSecrets.mockReset();
  scanArtifactForSecrets.mockReturnValue([]);
  installMocks();
});

afterEach(() => {
  vi.resetModules();
});

describe("app deploy work receipts (#359)", () => {
  it("persists validation and publish checkpoints on the originating run", async () => {
    const { POST } = await import("@/app/api/apps/[id]/deploy/route");
    const response = await POST(request(), {
      params: Promise.resolve({ id: "app-1" }),
    });

    expect(response.status).toBe(200);
    expect(appendRunEventBestEffort).toHaveBeenNthCalledWith(
      1,
      "app-deploy-run-event-error",
      expect.objectContaining({
        runId: "run-1",
        eventType: "app_version_validation_completed",
        status: "succeeded",
      }),
    );
    expect(appendRunEventBestEffort).toHaveBeenNthCalledWith(
      2,
      "app-deploy-run-event-error",
      expect.objectContaining({
        runId: "run-1",
        eventType: "app_version_published",
        status: "succeeded",
        label: "Published Dashboard · version 4",
      }),
    );
  });

  it("records a failed validation without attempting publish", async () => {
    scanArtifactForSecrets.mockReturnValue(["an API secret key"]);
    const { POST } = await import("@/app/api/apps/[id]/deploy/route");
    const response = await POST(request(), {
      params: Promise.resolve({ id: "app-1" }),
    });

    expect(response.status).toBe(422);
    expect(deployAppVersion).not.toHaveBeenCalled();
    expect(appendRunEventBestEffort).toHaveBeenCalledTimes(1);
    expect(appendRunEventBestEffort).toHaveBeenCalledWith(
      "app-deploy-run-event-error",
      expect.objectContaining({
        eventType: "app_version_validation_failed",
        status: "failed",
        error: "Credential scan blocked deployment.",
      }),
    );
  });

  it("records a failed publish without exposing the underlying exception", async () => {
    deployAppVersion.mockRejectedValueOnce(
      new Error("database host and credential-shaped provider details"),
    );
    const { POST } = await import("@/app/api/apps/[id]/deploy/route");
    const response = await POST(request(), {
      params: Promise.resolve({ id: "app-1" }),
    });

    expect(response.status).toBe(422);
    expect(appendRunEventBestEffort).toHaveBeenLastCalledWith(
      "app-deploy-run-event-error",
      expect.objectContaining({
        eventType: "app_version_publish_failed",
        status: "failed",
        error: "Could not publish this app version.",
      }),
    );
  });

  it("names the offending binding when the #802 provider gate refuses a live publish", async () => {
    const { LiveBindingGateError } = await import("@/lib/app-binding-gate");
    deployAppVersion.mockRejectedValueOnce(
      new LiveBindingGateError(
        "lake-1",
        "provider_not_viewer_identity",
        'data-lake/query (binding "lake-1") cannot be published live: data-lake does not support per-viewer credentials, a connect prompt, and per-viewer audit. Publish this version as a snapshot instead.',
      ),
    );
    const { POST } = await import("@/app/api/apps/[id]/deploy/route");
    const response = await POST(request(), {
      params: Promise.resolve({ id: "app-1" }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "live_binding_not_publishable",
      message: expect.stringContaining('binding "lake-1"'),
    });
    expect(appendRunEventBestEffort).toHaveBeenLastCalledWith(
      "app-deploy-run-event-error",
      expect.objectContaining({
        eventType: "app_version_publish_failed",
        status: "failed",
        metadata: expect.objectContaining({
          bindingId: "lake-1",
          reason: "provider_not_viewer_identity",
        }),
      }),
    );
  });
});
