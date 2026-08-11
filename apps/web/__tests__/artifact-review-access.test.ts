import type { Database, WorkspaceArtifact } from "@ai-workspace/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildWorkspaceArtifactVersionSet: vi.fn(),
  canListAppVersionForActor: vi.fn(() => true),
  loadWorkspaceArtifactById: vi.fn(),
  resolveAppActorRole: vi.fn(),
}));

vi.mock("@/lib/apps", () => ({
  canListAppVersionForActor: mocks.canListAppVersionForActor,
  resolveAppActorRole: mocks.resolveAppActorRole,
}));
vi.mock("@/lib/workspace-artifacts", () => ({
  buildWorkspaceArtifactVersionSet: mocks.buildWorkspaceArtifactVersionSet,
  loadWorkspaceArtifactById: mocks.loadWorkspaceArtifactById,
}));

import { resolveArtifactReviewAccess } from "@/lib/artifact-review-access";

const artifact = artifactRow();
const actor = { id: "unshared-user", role: "user" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadWorkspaceArtifactById.mockResolvedValue(artifact);
});

describe("artifact review access", () => {
  it("does not expose a deployed app artifact to an unshared user", async () => {
    mocks.resolveAppActorRole.mockResolvedValue("none");
    const db = linkedAppDb();

    const access = await resolveArtifactReviewAccess({
      db,
      actor,
      artifactId: artifact.id,
    });

    expect(access).toBeNull();
    expect(mocks.canListAppVersionForActor).not.toHaveBeenCalled();
  });

  it("lets an active viewer review the visible version without addressing it", async () => {
    mocks.resolveAppActorRole.mockResolvedValue("viewer");
    const db = linkedAppDb();

    const access = await resolveArtifactReviewAccess({
      db,
      actor: { id: "shared-viewer", role: "user" },
      artifactId: artifact.id,
    });

    expect(access).toMatchObject({
      artifact,
      role: "viewer",
      canComment: true,
      canAddress: false,
    });
    expect(mocks.canListAppVersionForActor).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deployed" }),
      { actorRole: "viewer", visibleToUserId: "shared-viewer" },
    );
  });
});

function linkedAppDb(): Database {
  return {
    select: vi.fn(() =>
      selectQuery([
        {
          app: {
            id: "app-1",
            ownerUserId: artifact.userId,
            archivedAt: null,
          },
          version: {
            id: "app-version-1",
            artifactId: artifact.id,
            status: "deployed",
            createdByUserId: artifact.userId,
          },
        },
      ]),
    ),
  } as unknown as Database;
}

function selectQuery<T>(rows: T[]) {
  const resolved = Promise.resolve(rows);
  const query = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    then: resolved.then.bind(resolved),
  };
  return query;
}

function artifactRow(): WorkspaceArtifact {
  return {
    id: "artifact-shared-1",
    userId: "owner-1",
    threadId: "thread-1",
    chatMessageId: "message-1",
    runId: "run-1",
    title: "Launch app",
    filename: "launch-app.html",
    kind: "html",
    mimeType: "text/html",
    content: "<h1>Launch</h1>",
    sizeBytes: 15,
    source: "assistant-code-block",
    artifactGroupId: "artifact-group-1",
    versionNumber: 1,
    supersedesArtifactId: null,
    versionSummary: null,
    metadata: {},
    createdAt: new Date("2026-08-11T12:00:00.000Z"),
    updatedAt: new Date("2026-08-11T12:00:00.000Z"),
  };
}
