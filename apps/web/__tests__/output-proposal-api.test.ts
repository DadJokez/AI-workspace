import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";
import type { WorkspaceArtifact } from "@ai-workspace/db";

const user: SessionUser = {
  id: "user-1",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

function artifact(
  status: "proposed" | "accepted" | "discarded" = "proposed",
): WorkspaceArtifact {
  return {
    id: "artifact-1",
    userId: user.id,
    threadId: "thread-1",
    chatMessageId: "message-1",
    runId: "run-1",
    title: "Weekly report",
    filename: "weekly-report.md",
    artifactGroupId: "artifact-group-1",
    versionNumber: 2,
    supersedesArtifactId: "artifact-v1",
    versionSummary: "Updated the weekly report.",
    kind: "document",
    mimeType: "text/markdown",
    content: "# Weekly report",
    sizeBytes: 15,
    source: "assistant",
    metadata: {
      lineDelta: { added: 2, removed: 1, approximate: false },
      outputProposal: {
        status,
        runId: "run-1",
        triggerType: "scheduled",
        createdAt: "2026-07-23T12:00:00.000Z",
      },
    },
    createdAt: new Date("2026-07-23T12:00:00.000Z"),
    updatedAt: new Date("2026-07-23T12:00:00.000Z"),
  } as WorkspaceArtifact;
}

function fakeDb({
  appVersionRows = [],
  updatedArtifact = artifact("accepted"),
}: {
  appVersionRows?: Array<Record<string, unknown>>;
  updatedArtifact?: WorkspaceArtifact;
} = {}) {
  const captured = {
    updates: [] as Array<Record<string, unknown>>,
    audits: [] as Array<Record<string, unknown>>,
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(appVersionRows),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        captured.updates.push(values);
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([
                {
                  ...updatedArtifact,
                  metadata: values.metadata,
                  updatedAt: values.updatedAt,
                },
              ]),
          }),
        };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        captured.audits.push(values);
        return Promise.resolve();
      },
    }),
    transaction: async <T>(callback: (tx: unknown) => Promise<T>) =>
      callback(db),
  };
  return { db, captured };
}

async function install({
  row = artifact(),
  appVersionRows = [],
}: {
  row?: WorkspaceArtifact | null;
  appVersionRows?: Array<Record<string, unknown>>;
} = {}) {
  const { db, captured } = fakeDb({ appVersionRows });
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => user,
  }));
  vi.doMock("@/lib/workspace-artifacts", () => ({
    loadWorkspaceArtifactForUser: async () => row,
    serializeWorkspaceArtifact: (value: WorkspaceArtifact) => value,
    serializeWorkspaceArtifactDetail: (value: WorkspaceArtifact) => value,
  }));
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    return { ...actual, getDb: () => db as never };
  });
  const route = await import("@/app/api/workspace/artifacts/[id]/route");
  return { ...route, captured };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("workspace artifact proposal decisions", () => {
  it("accepts the owner's pending proposal and writes an audit event", async () => {
    const { PATCH, captured } = await install();

    const response = await PATCH(
      new Request("http://localhost/api/workspace/artifacts/artifact-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "accepted" }),
      }),
      { params: Promise.resolve({ id: "artifact-1" }) },
    );

    expect(response.status).toBe(200);
    expect(captured.updates[0]).toMatchObject({
      metadata: {
        lineDelta: { added: 2, removed: 1, approximate: false },
        outputProposal: {
          status: "accepted",
          decidedByUserId: user.id,
        },
      },
    });
    expect(captured.audits[0]).toMatchObject({
      actionType: "proposal_accepted",
      actorUserId: user.id,
      runId: "run-1",
    });
  });

  it("requires app proposals to use the governed app-version action", async () => {
    const { PATCH, captured } = await install({
      appVersionRows: [{ id: "version-1" }],
    });

    const response = await PATCH(
      new Request("http://localhost/api/workspace/artifacts/artifact-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "discarded" }),
      }),
      { params: Promise.resolve({ id: "artifact-1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "app_proposal",
    });
    expect(captured.updates).toHaveLength(0);
  });

  it("does not allow a decided proposal to transition again", async () => {
    const { PATCH, captured } = await install({ row: artifact("discarded") });

    const response = await PATCH(
      new Request("http://localhost/api/workspace/artifacts/artifact-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "accepted" }),
      }),
      { params: Promise.resolve({ id: "artifact-1" }) },
    );

    expect(response.status).toBe(409);
    expect(captured.updates).toHaveLength(0);
  });
});
