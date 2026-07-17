import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";
import type {
  App,
  AppEditSession,
  AppVersion,
  WorkspaceArtifact,
} from "@ai-workspace/db";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";

const fixedDate = new Date("2026-06-17T12:00:00.000Z");

const ownerSession: SessionUser = {
  id: "owner-1",
  email: "owner@example.com",
  displayName: "Owner",
  role: "user",
};

const editorSession: SessionUser = {
  id: "editor-1",
  email: "editor@example.com",
  displayName: "Editor",
  role: "user",
};

const strangerSession: SessionUser = {
  id: "stranger-1",
  email: "stranger@example.com",
  displayName: "Stranger",
  role: "user",
};

function makeApp(overrides: Partial<App> = {}): App {
  return {
    id: "app-1",
    ownerUserId: ownerSession.id,
    name: "Lifecycle Demo",
    description: null,
    slug: "lifecycle-demo",
    liveArtifactId: "artifact-live",
    liveVersionId: "version-live",
    status: "deployed",
    sourceThreadId: "source-thread-1",
    archivedAt: null,
    createdAt: fixedDate,
    updatedAt: fixedDate,
    ...overrides,
  } as App;
}

function makeVersion(overrides: Partial<AppVersion> = {}): AppVersion {
  return {
    id: "version-1",
    appId: "app-1",
    artifactId: "artifact-1",
    versionNumber: 1,
    status: "draft",
    summary: "Draft",
    createdByUserId: ownerSession.id,
    sourceThreadId: "source-thread-1",
    createdAt: fixedDate,
    deployedAt: null,
    ...overrides,
  } as AppVersion;
}

function makeSession(overrides: Partial<AppEditSession> = {}): AppEditSession {
  return {
    id: "session-1",
    appId: "app-1",
    threadId: "edit-thread-1",
    baseVersionId: "version-live",
    status: "active",
    createdByUserId: editorSession.id,
    createdAt: fixedDate,
    completedAt: null,
    ...overrides,
  } as AppEditSession;
}

function makeArtifact(overrides: Partial<WorkspaceArtifact> = {}): WorkspaceArtifact {
  return {
    id: "artifact-1",
    userId: editorSession.id,
    threadId: "edit-thread-1",
    chatMessageId: "message-1",
    runId: "run-1",
    title: "App draft",
    filename: "app.html",
    artifactGroupId: "artifact-group-1",
    versionNumber: 1,
    supersedesArtifactId: null,
    versionSummary: "Make it blue",
    kind: "file",
    mimeType: "text/html",
    content: "<!doctype html><html><body>ok</body></html>",
    sizeBytes: 42,
    source: "assistant",
    metadata: null,
    createdAt: fixedDate,
    updatedAt: fixedDate,
    ...overrides,
  } as WorkspaceArtifact;
}

function makeArtifactSummary(
  overrides: Partial<WorkspaceArtifactSummary> = {},
): WorkspaceArtifactSummary {
  return {
    id: "artifact-1",
    title: "App draft",
    filename: "app.html",
    kind: "file",
    mimeType: "text/html",
    sizeBytes: 42,
    source: "assistant",
    threadId: "edit-thread-1",
    chatMessageId: "message-1",
    runId: "run-1",
    artifactGroupId: "artifact-group-1",
    versionNumber: 1,
    supersedesArtifactId: null,
    versionSummary: "Make it blue",
    metadata: null,
    createdAt: fixedDate.toISOString(),
    previewUrl: "/workspace/artifacts/artifact-1",
    downloadUrl: "/api/workspace/artifacts/artifact-1/download",
    ...overrides,
  };
}

interface MockDb {
  selectQueue: Array<Array<unknown>>;
  returningQueue: Array<Array<unknown>>;
  updateSets: Array<Record<string, unknown>>;
  insertValues: Array<Record<string, unknown>>;
}

interface FluentDb {
  select: () => unknown;
  update: () => unknown;
  insert: () => unknown;
  transaction: <T>(callback: (tx: FluentDb) => Promise<T>) => Promise<T>;
}

function createDbMock() {
  const state: MockDb = {
    selectQueue: [],
    returningQueue: [],
    updateSets: [],
    insertValues: [],
  };

  const query: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined;
        if (prop === "set") {
          return (value: Record<string, unknown>) => {
            state.updateSets.push(value);
            return query;
          };
        }
        if (prop === "values") {
          return (value: Record<string, unknown>) => {
            state.insertValues.push(value);
            return query;
          };
        }
        if (prop === "returning") {
          return () => Promise.resolve(state.returningQueue.shift() ?? []);
        }
        if (prop === "limit") {
          return () => Promise.resolve(state.selectQueue.shift() ?? []);
        }
        return () => query;
      },
    },
  );

  const db: FluentDb = {
    select: () => query,
    update: () => query,
    insert: () => query,
    transaction: async <T>(callback: (tx: FluentDb) => Promise<T>) =>
      callback(db),
  };

  return { db, state };
}

function makeJsonRequest(body: unknown) {
  return new Request("http://localhost/api/apps/app-1/deploy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let loadWorkspaceArtifactById = vi.fn();
let loadWorkspaceArtifactForUser = vi.fn();

function installMocks(db: unknown, session: SessionUser | null) {
  loadWorkspaceArtifactById = vi.fn();
  loadWorkspaceArtifactForUser = vi.fn();
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => session,
  }));
  vi.doMock("@/lib/workspace-artifacts", () => ({
    loadWorkspaceArtifactById,
    loadWorkspaceArtifactForUser,
  }));
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    return { ...actual, getDb: () => db as never };
  });
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("app lifecycle stateful paths", () => {
  it("deploys a rollback by reverting the previous live version and auditing rollback", async () => {
    const { db, state } = createDbMock();
    const app = makeApp({ liveVersionId: "version-2" });
    const version = makeVersion({
      id: "version-1",
      artifactId: "artifact-1",
      versionNumber: 1,
      status: "draft",
      createdByUserId: editorSession.id,
      sourceThreadId: "edit-thread-1",
    });
    const updated = makeApp({
      liveVersionId: version.id,
      liveArtifactId: version.artifactId,
    });

    state.selectQueue = [[{ versionNumber: 2 }]];
    state.returningQueue = [
      [updated],
      [{ id: "session-1", threadId: "edit-thread-1" }],
    ];
    installMocks(db, ownerSession);
    loadWorkspaceArtifactById.mockResolvedValue(makeArtifact());

    const { deployAppVersion } = await import("@/lib/apps");
    const result = await deployAppVersion({
      db: db as never,
      app,
      version,
      actorUserId: ownerSession.id,
    });

    expect(result.liveVersionId).toBe(version.id);
    expect(state.updateSets[0]).toMatchObject({ status: "reverted" });
    expect(state.updateSets[1]).toMatchObject({ status: "deployed" });
    expect(state.updateSets[2]).toMatchObject({
      liveVersionId: version.id,
      liveArtifactId: version.artifactId,
      status: "deployed",
    });
    expect(state.updateSets[3]).toMatchObject({
      status: "completed",
      completedAt: expect.any(Date),
    });
    expect(state.insertValues).toContainEqual(
      expect.objectContaining({
        actionType: "app_edit_session_complete",
        actorUserId: ownerSession.id,
      }),
    );
    expect(state.insertValues).toContainEqual(
      expect.objectContaining({
        actionType: "app_rollback",
        actorUserId: ownerSession.id,
      }),
    );
  });

  it.each([
    ["version id", { appVersionId: "version-1" }],
    ["artifact fallback", { artifactId: "artifact-1" }],
  ])("denies editor deploy through %s before loading deploy content", async (_label, body) => {
    const { db, state } = createDbMock();
    state.selectQueue = [[makeApp()], [{ role: "editor" }]];
    installMocks(db, editorSession);

    const { POST } = await import("@/app/api/apps/[id]/deploy/route");
    const res = await POST(makeJsonRequest(body), {
      params: Promise.resolve({ id: "app-1" }),
    });

    expect(res.status).toBe(403);
    expect(loadWorkspaceArtifactById).not.toHaveBeenCalled();
    expect(loadWorkspaceArtifactForUser).not.toHaveBeenCalled();
    expect(state.insertValues).toContainEqual(
      expect.objectContaining({ actionType: "app_deploy_denied" }),
    );
  });

  it("hides deploy route app existence from unrelated users", async () => {
    const { db, state } = createDbMock();
    state.selectQueue = [[makeApp()], []];
    installMocks(db, strangerSession);

    const { POST } = await import("@/app/api/apps/[id]/deploy/route");
    const res = await POST(makeJsonRequest({ appVersionId: "version-1" }), {
      params: Promise.resolve({ id: "app-1" }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "app_not_found" });
  });

  it("hides another editor's draft when discarding a version", async () => {
    const { db, state } = createDbMock();
    state.selectQueue = [
      [makeApp()],
      [{ role: "editor" }],
      [
        makeVersion({
          id: "version-foreign",
          status: "draft",
          createdByUserId: ownerSession.id,
        }),
      ],
    ];
    installMocks(db, editorSession);

    const { DELETE } = await import(
      "@/app/api/apps/[id]/versions/[versionId]/route"
    );
    const res = await DELETE(
      new Request("http://localhost/api/apps/app-1/versions/version-foreign", {
        method: "DELETE",
      }),
      {
        params: Promise.resolve({ id: "app-1", versionId: "version-foreign" }),
      },
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: "version_not_found",
    });
  });

  it("revokes stale edit context after an editor loses access", async () => {
    const { db, state } = createDbMock();
    state.selectQueue = [
      [
        {
          session: makeSession(),
          app: makeApp(),
          baseVersion: makeVersion({ status: "deployed" }),
        },
      ],
      [{ role: "user" }],
      [],
    ];
    installMocks(db, editorSession);

    const { buildAppEditContext } = await import("@/lib/apps");
    const context = await buildAppEditContext({
      db: db as never,
      userId: editorSession.id,
      threadId: "edit-thread-1",
    });

    expect(context).toBeNull();
    expect(loadWorkspaceArtifactById).not.toHaveBeenCalled();
    expect(state.updateSets).toContainEqual(
      expect.objectContaining({ status: "revoked" }),
    );
    expect(state.insertValues).toContainEqual(
      expect.objectContaining({ actionType: "app_edit_denied" }),
    );
  });

  it("stops draft minting after an active editor session loses access", async () => {
    const { db, state } = createDbMock();
    state.selectQueue = [
      [{ session: makeSession(), app: makeApp() }],
      [{ role: "user" }],
      [],
    ];
    installMocks(db, editorSession);

    const { createDraftAppVersionsForThreadArtifacts } = await import("@/lib/apps");
    const result = await createDraftAppVersionsForThreadArtifacts({
      db: db as never,
      userId: editorSession.id,
      threadId: "edit-thread-1",
      artifacts: [makeArtifactSummary()],
      sourceContentOmitted: false,
    });

    expect(result).toEqual({ created: [], summaries: [], rejected: [] });
    expect(loadWorkspaceArtifactById).not.toHaveBeenCalled();
    expect(state.updateSets).toContainEqual(
      expect.objectContaining({ status: "revoked" }),
    );
  });

  it("creates a draft version from complete HTML in an active editor session", async () => {
    const { db, state } = createDbMock();
    const createdVersion = makeVersion({
      id: "version-4",
      versionNumber: 4,
      createdByUserId: editorSession.id,
      sourceThreadId: "edit-thread-1",
    });
    state.selectQueue = [
      [{ session: makeSession(), app: makeApp() }],
      [{ role: "user" }],
      [{ role: "editor" }],
      [],
      [{ versionNumber: 3 }],
    ];
    state.returningQueue = [[createdVersion]];
    installMocks(db, editorSession);
    loadWorkspaceArtifactById.mockResolvedValue(makeArtifact());

    const { createDraftAppVersionsForThreadArtifacts } = await import("@/lib/apps");
    const result = await createDraftAppVersionsForThreadArtifacts({
      db: db as never,
      userId: editorSession.id,
      threadId: "edit-thread-1",
      artifacts: [makeArtifactSummary()],
      sourceContentOmitted: false,
    });

    expect(result.created).toEqual([createdVersion]);
    expect(result.summaries).toEqual([
      {
        id: "version-4",
        appId: "app-1",
        appName: "Lifecycle Demo",
        appSlug: "lifecycle-demo",
        artifactId: "artifact-1",
        versionNumber: 4,
        status: "draft",
        canDeploy: false,
        previewUrl: "/api/apps/app-1/versions/version-4/content",
        liveUrl: "/apps/lifecycle-demo",
      },
    ]);
    expect(state.insertValues).toContainEqual(
      expect.objectContaining({
        appId: "app-1",
        artifactId: "artifact-1",
        versionNumber: 4,
        status: "draft",
        createdByUserId: editorSession.id,
        sourceThreadId: "edit-thread-1",
      }),
    );
    expect(state.insertValues).toContainEqual(
      expect.objectContaining({
        actionType: "app_draft_created",
        actorUserId: editorSession.id,
        metadata: expect.objectContaining({
          appVersionId: "version-4",
          appEditSessionId: "session-1",
          artifactId: "artifact-1",
          threadId: "edit-thread-1",
          versionNumber: 4,
        }),
      }),
    );
  });
  it("returns contentOmittedForSize when the app source exceeds the injection cap (#344)", async () => {
    const { db, state } = createDbMock();
    state.selectQueue = [
      [
        {
          session: makeSession(),
          app: makeApp(),
          baseVersion: makeVersion({ status: "deployed" }),
        },
      ],
      [{ role: "user" }],
      [{ role: "editor" }],
    ];
    installMocks(db, editorSession);
    loadWorkspaceArtifactById.mockResolvedValue(
      makeArtifact({ content: `<!doctype html>${"x".repeat(60_001)}` }),
    );

    const { buildAppEditContext } = await import("@/lib/apps");
    const result = await buildAppEditContext({
      db: db as never,
      userId: editorSession.id,
      threadId: "edit-thread-1",
    });

    expect(result?.contentOmittedForSize).toBe(true);
    expect(result?.context).not.toContain("x".repeat(1_000));
  });

  it("reports contentOmittedForSize false when the app source fits (#344)", async () => {
    const { db, state } = createDbMock();
    state.selectQueue = [
      [
        {
          session: makeSession(),
          app: makeApp(),
          baseVersion: makeVersion({ status: "deployed" }),
        },
      ],
      [{ role: "user" }],
      [{ role: "editor" }],
    ];
    installMocks(db, editorSession);
    loadWorkspaceArtifactById.mockResolvedValue(makeArtifact());

    const { buildAppEditContext } = await import("@/lib/apps");
    const result = await buildAppEditContext({
      db: db as never,
      userId: editorSession.id,
      threadId: "edit-thread-1",
    });

    expect(result?.contentOmittedForSize).toBe(false);
    expect(result?.context).toContain("<!doctype html>");
  });

  it("structurally refuses draft minting when source content was omitted (#344)", async () => {
    const { db, state } = createDbMock();
    state.selectQueue = [
      [{ session: makeSession(), app: makeApp() }],
      [{ role: "user" }],
      [{ role: "editor" }],
    ];
    installMocks(db, editorSession);
    loadWorkspaceArtifactById.mockResolvedValue(makeArtifact());

    const { createDraftAppVersionsForThreadArtifacts } = await import("@/lib/apps");
    const result = await createDraftAppVersionsForThreadArtifacts({
      db: db as never,
      userId: editorSession.id,
      threadId: "edit-thread-1",
      artifacts: [makeArtifactSummary()],
      sourceContentOmitted: true,
    });

    expect(result).toEqual({
      created: [],
      summaries: [],
      rejected: [
        { artifactId: "artifact-1", reason: "source_content_omitted" },
      ],
    });
    // No app version row was written — only the audit record.
    expect(state.insertValues).not.toContainEqual(
      expect.objectContaining({ status: "draft" }),
    );
    expect(state.insertValues).toContainEqual(
      expect.objectContaining({
        actionType: "app_draft_blocked_source_omitted",
        actorUserId: editorSession.id,
        metadata: expect.objectContaining({
          artifactIds: ["artifact-1"],
          threadId: "edit-thread-1",
        }),
      }),
    );
  });
  it("stamps a re-minted existing deployed version truthfully — never an actionable draft (#344)", async () => {
    const { db, state } = createDbMock();
    const existingDeployed = makeVersion({
      id: "version-2",
      versionNumber: 2,
      status: "deployed",
    });
    state.selectQueue = [
      [{ session: makeSession(), app: makeApp() }],
      [{ role: "user" }],
      [{ role: "editor" }],
      // createAppVersionForArtifact finds the existing (appId, artifactId) row
      [existingDeployed],
    ];
    installMocks(db, editorSession);
    loadWorkspaceArtifactById.mockResolvedValue(makeArtifact());

    const { createDraftAppVersionsForThreadArtifacts } = await import("@/lib/apps");
    const result = await createDraftAppVersionsForThreadArtifacts({
      db: db as never,
      userId: editorSession.id,
      threadId: "edit-thread-1",
      artifacts: [makeArtifactSummary()],
      sourceContentOmitted: false,
    });

    expect(result.summaries).toEqual([
      expect.objectContaining({
        id: "version-2",
        status: "deployed",
        canDeploy: false,
      }),
    ]);
    // No new version row inserted — the existing one was reused.
    expect(state.insertValues).not.toContainEqual(
      expect.objectContaining({ status: "draft", artifactId: "artifact-1" }),
    );
  });
});
