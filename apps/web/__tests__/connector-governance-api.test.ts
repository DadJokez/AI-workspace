import type { SessionUser } from "@ai-workspace/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const admin: SessionUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin",
};
const user: SessionUser = {
  id: "00000000-0000-4000-8000-000000000402",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("connector governance APIs", () => {
  it("records actor, reason, and lifecycle timestamps when disabling a connector", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const audits: Array<Record<string, unknown>> = [];
    const prior = {
      id: "00000000-0000-4000-8000-000000000410",
      slug: "github",
      status: "active",
      ownerUserId: null,
      credentialType: "delegated_oauth",
      credentialTtlSeconds: null,
      lastRotatedAt: null,
    };
    const db = mockDb({
      selectRows: [prior],
      selectResponses: [[prior], [{ id: user.id }]],
      updatedRows: [{ ...prior, status: "disabled" }],
      updates,
      audits,
    });
    installAdminMocks(db);

    const { PATCH } = await import("@/app/api/admin/connectors/[id]/route");
    const response = await PATCH(
      new Request("http://test.local/api/admin/connectors/connector", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "disabled",
          ownerUserId: user.id,
          credentialType: "delegated_oauth",
          credentialTtlSeconds: 3600,
          reason: "Vendor incident",
        }),
      }),
      { params: Promise.resolve({ id: prior.id }) },
    );

    expect(response.status).toBe(200);
    expect(updates[0]).toMatchObject({
      status: "disabled",
      ownerUserId: user.id,
      disabledBy: admin.id,
      statusReason: "Vendor incident",
    });
    expect(updates[0]!.disabledAt).toBeInstanceOf(Date);
    expect(audits[0]).toMatchObject({
      actorUserId: admin.id,
      actionType: "connector.disabled",
      provider: "github",
      metadata: expect.objectContaining({ reason: "Vendor incident" }),
    });
  });

  it("rejects a connector owner that does not exist", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const prior = {
      id: "00000000-0000-4000-8000-000000000410",
      slug: "github",
      status: "active",
      ownerUserId: null,
      credentialType: "delegated_oauth",
      credentialTtlSeconds: null,
      lastRotatedAt: null,
    };
    const db = mockDb({
      selectRows: [prior],
      selectResponses: [[prior], []],
      updatedRows: [],
      updates,
      audits: [],
    });
    installAdminMocks(db);

    const { PATCH } = await import("@/app/api/admin/connectors/[id]/route");
    const response = await PATCH(
      new Request("http://test.local/api/admin/connectors/connector", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerUserId: crypto.randomUUID() }),
      }),
      { params: Promise.resolve({ id: prior.id }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_connector_update",
      message: "Choose an existing connector owner.",
    });
    expect(updates).toEqual([]);
  });

  it("requires a reason before a connector can be disabled", async () => {
    const db = mockDb({ selectRows: [], updatedRows: [], updates: [], audits: [] });
    installAdminMocks(db);
    const { PATCH } = await import("@/app/api/admin/connectors/[id]/route");
    const response = await PATCH(
      new Request("http://test.local/api/admin/connectors/connector", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "disabled" }),
      }),
      { params: Promise.resolve({ id: crypto.randomUUID() }) },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_connector_update",
    });
  });

  it("persists catalog policy controls with an audit decision", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const audits: Array<Record<string, unknown>> = [];
    const prior = {
      id: "00000000-0000-4000-8000-000000000411",
      provider: "google",
      toolName: "create_draft",
      policy: "needs_approval",
      enabled: true,
    };
    const db = mockDb({
      selectRows: [prior],
      updatedRows: [{ id: prior.id, policy: "blocked", enabled: false }],
      updates,
      audits,
    });
    installAdminMocks(db);

    const { PATCH } = await import(
      "@/app/api/admin/connectors/tools/[id]/route"
    );
    const response = await PATCH(
      new Request("http://test.local/api/admin/connectors/tools/tool", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy: "blocked", enabled: false }),
      }),
      { params: Promise.resolve({ id: prior.id }) },
    );

    expect(response.status).toBe(200);
    expect(updates[0]).toMatchObject({ policy: "blocked", enabled: false });
    expect(audits[0]).toMatchObject({
      actorUserId: admin.id,
      actionType: "connector.tool_policy_updated",
      provider: "google",
      toolName: "create_draft",
    });
  });

  it("lets an admin revoke a specific user connection with a required reason", async () => {
    const revoke = vi.fn(async () => ({ revoked: true, attestations: 2 }));
    const db = mockDb({
      selectRows: [{ userId: user.id, provider: "notion" }],
      updatedRows: [],
      updates: [],
      audits: [],
    });
    installAdminMocks(db);
    vi.doMock("@/lib/oauth/connection", () => ({ revokeOAuthConnection: revoke }));

    const { DELETE } = await import(
      "@/app/api/admin/connectors/connections/[id]/route"
    );
    const response = await DELETE(
      new Request("http://test.local/api/admin/connectors/connections/id", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "User left the project" }),
      }),
      { params: Promise.resolve({ id: crypto.randomUUID() }) },
    );

    expect(response.status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        userId: user.id,
        provider: "notion",
        actorUserId: admin.id,
        reason: "User left the project",
        source: "admin.connectors",
      }),
    );
  });

  it("lets an account owner disconnect only their own supported provider", async () => {
    const revoke = vi.fn(async () => ({ revoked: true, attestations: 1 }));
    vi.doMock("@/lib/auth/requireSession", () => ({
      requireSession: async () => ({ user }),
    }));
    vi.doMock("@/lib/oauth/connection", () => ({ revokeOAuthConnection: revoke }));
    vi.doMock("@/lib/oauth/mcp-servers", () => ({
      SUPPORTED_MCP_PROVIDERS: ["github", "notion"],
    }));

    const { DELETE } = await import(
      "@/app/api/oauth/connections/[provider]/route"
    );
    const response = await DELETE(
      new Request("http://test.local/api/oauth/connections/github", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ provider: "github" }) },
    );

    expect(response.status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        provider: "github",
        actorUserId: user.id,
        source: "settings.integrations",
      }),
    );
  });
});

function installAdminMocks(db: ReturnType<typeof mockDb>) {
  vi.doMock("@/lib/auth/requireAdmin", () => ({
    requireAdmin: async () => ({ user: admin }),
  }));
  vi.doMock("@ai-workspace/db", async () => {
    const actual = await vi.importActual<typeof import("@ai-workspace/db")>(
      "@ai-workspace/db",
    );
    return { ...actual, getDb: () => db };
  });
}

function mockDb({
  selectRows,
  selectResponses,
  updatedRows,
  updates,
  audits,
}: {
  selectRows: Array<Record<string, unknown>>;
  selectResponses?: Array<Array<Record<string, unknown>>>;
  updatedRows: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
}) {
  let selectCall = 0;

  return {
    select: () => {
      const rows = selectResponses?.[selectCall++] ?? selectRows;
      const selectChain: Record<string, unknown> = {};
      selectChain.from = () => selectChain;
      selectChain.where = () => selectChain;
      selectChain.limit = async () => rows;
      return selectChain;
    },
    update: () => ({
      set: (value: Record<string, unknown>) => {
        updates.push(value);
        return {
          where: () => ({ returning: async () => updatedRows }),
        };
      },
    }),
    insert: () => ({
      values: async (value: Record<string, unknown>) => {
        audits.push(value);
      },
    }),
  };
}
