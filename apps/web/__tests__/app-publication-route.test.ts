import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionUser = vi.fn();
const resolveAppActorRole = vi.fn();
const auditAppMutation = vi.fn();
const updateSet = vi.fn();

let appRow = {
  id: "app-1",
  slug: "pipeline",
  ownerUserId: "owner-1",
  status: "deployed",
  liveArtifactId: "artifact-1",
  liveVersionId: "version-1",
  archivedAt: null as Date | null,
};

const db = {
  select: () => ({
    from: () => ({
      where: () => ({ limit: async () => [appRow] }),
    }),
  }),
  update: () => ({
    set: (value: Record<string, unknown>) => {
      updateSet(value);
      return {
        where: () => ({
          returning: async () => [{ ...appRow, ...value }],
        }),
      };
    },
  }),
};

vi.mock("@ai-workspace/db", () => ({
  apps: {},
  getDb: () => db,
}));
vi.mock("@/lib/auth/getSessionUser", () => ({ getSessionUser }));
vi.mock("@/lib/apps", () => ({
  resolveAppActorRole,
  canAppRoleDeploy: (role: string) => role === "owner" || role === "admin",
  auditAppMutation,
}));

async function callRoute() {
  const { DELETE } = await import("@/app/api/apps/[id]/publication/route");
  return DELETE(new Request("https://c.example/api/apps/app-1/publication"), {
    params: Promise.resolve({ id: "app-1" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionUser.mockResolvedValue({
    id: "owner-1",
    role: "user",
    email: "owner@example.com",
    displayName: "Owner",
  });
  resolveAppActorRole.mockResolvedValue("owner");
  appRow = {
    id: "app-1",
    slug: "pipeline",
    ownerUserId: "owner-1",
    status: "deployed",
    liveArtifactId: "artifact-1",
    liveVersionId: "version-1",
    archivedAt: null,
  };
});

describe("DELETE /api/apps/[id]/publication", () => {
  it("unpublishes without clearing the stable URL or live version", async () => {
    const response = await callRoute();

    expect(response.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "unpublished" }),
    );
    expect(updateSet.mock.calls[0]?.[0]).not.toHaveProperty("liveVersionId");
    expect(updateSet.mock.calls[0]?.[0]).not.toHaveProperty("liveArtifactId");
    expect(auditAppMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "app_unpublish",
        metadata: expect.objectContaining({
          appVersionId: "version-1",
          retainedSlug: "pipeline",
        }),
      }),
    );
  });

  it("does not let an editor unpublish", async () => {
    resolveAppActorRole.mockResolvedValueOnce("editor");

    const response = await callRoute();

    expect(response.status).toBe(403);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("is idempotent when the app is already unpublished", async () => {
    appRow = { ...appRow, status: "unpublished" };

    const response = await callRoute();

    expect(response.status).toBe(200);
    expect(updateSet).not.toHaveBeenCalled();
    expect(auditAppMutation).not.toHaveBeenCalled();
  });
});
