import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDb, loadArtifactVersionsForReview, requireSession } =
  vi.hoisted(() => ({
    getDb: vi.fn(() => ({ id: "db" })),
    loadArtifactVersionsForReview: vi.fn(),
    requireSession: vi.fn(),
  }));

vi.mock("@ai-workspace/db", () => ({ getDb }));
vi.mock("@/lib/auth/requireSession", () => ({ requireSession }));
vi.mock("@/lib/artifact-review-access", () => ({
  loadArtifactVersionsForReview,
}));

import { GET } from "@/app/api/workspace/artifacts/[id]/versions/route";

const user = {
  id: "user-1",
  email: "rob@example.com",
  displayName: "Rob",
  role: "user",
};
const versionSet = {
  selectedArtifactId: "artifact-v1",
  latestArtifactId: "artifact-v2",
  staleBase: true,
  versions: [
    { id: "artifact-v1", versionNumber: 1 },
    { id: "artifact-v2", versionNumber: 2 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue({ user });
  loadArtifactVersionsForReview.mockResolvedValue(versionSet);
});

describe("GET /api/workspace/artifacts/[id]/versions", () => {
  it("loads version history inside the authenticated user's scope", async () => {
    const response = await getVersions("artifact-v1");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(versionSet);
    expect(loadArtifactVersionsForReview).toHaveBeenCalledWith({
      db: { id: "db" },
      actor: user,
      artifactId: "artifact-v1",
    });
  });

  it("returns 404 when the artifact is outside the user's scope", async () => {
    loadArtifactVersionsForReview.mockResolvedValue(null);

    const response = await getVersions("artifact-foreign");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "artifact_not_found" });
  });

  it("returns the shared session error before loading artifacts", async () => {
    requireSession.mockResolvedValue({
      error: Response.json({ error: "unauthorized" }, { status: 401 }),
    });

    const response = await getVersions("artifact-v1");

    expect(response.status).toBe(401);
    expect(loadArtifactVersionsForReview).not.toHaveBeenCalled();
  });
});

function getVersions(id: string) {
  return GET(
    new Request(`http://localhost/api/workspace/artifacts/${id}/versions`),
    { params: Promise.resolve({ id }) },
  );
}
