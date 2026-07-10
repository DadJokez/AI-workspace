import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

const session: SessionUser = {
  id: "00000000-0000-4000-8000-000000000260",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

let rows: Array<{ provider: string; expiresAt: Date | null }> = [];

function installMocks() {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => session,
  }));
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    const selectQuery: Record<string, unknown> = {};
    selectQuery.from = () => selectQuery;
    selectQuery.where = async () => rows;
    return {
      ...actual,
      getDb: () =>
        ({
          select: () => selectQuery,
        }) as never,
    };
  });
}

beforeEach(() => {
  rows = [];
});

afterEach(() => {
  vi.resetModules();
});

describe("GET /api/oauth/status", () => {
  it("reports Notion connected only when the delegated token is active", async () => {
    rows = [
      { provider: "github", expiresAt: null },
      { provider: "notion", expiresAt: new Date(Date.now() + 60_000) },
      { provider: "google", expiresAt: new Date(Date.now() - 60_000) },
    ];
    installMocks();
    const { GET } = await import("@/app/api/oauth/status/route");

    const res = await GET();
    await expect(res.json()).resolves.toMatchObject({
      github: true,
      notion: true,
      google: false,
      providerDetails: {
        github: {
          connected: true,
          executionConfigured: true,
          toolAvailable: true,
          status: "ready",
        },
        notion: {
          connected: true,
          executionConfigured: true,
          toolAvailable: true,
          status: "ready",
        },
        google: {
          connected: false,
          executionConfigured: false,
          toolAvailable: false,
          status: "not_connected",
        },
      },
    });
  });

  it("reports Google connected but pending execution until a Gateway target exists", async () => {
    rows = [
      { provider: "google", expiresAt: new Date(Date.now() + 60_000) },
    ];
    installMocks();
    const { GET } = await import("@/app/api/oauth/status/route");

    const res = await GET();
    await expect(res.json()).resolves.toMatchObject({
      google: true,
      providerDetails: {
        google: {
          connected: true,
          executionConfigured: false,
          toolAvailable: false,
          status: "connected_execution_not_configured",
          reason: "integration_coming_soon",
        },
      },
    });
  });
});
