import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

const session: SessionUser = {
  id: "00000000-0000-4000-8000-000000000260",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

let providerAvailability: Record<string, Record<string, unknown>> = {};

function installMocks() {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => session,
  }));
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    return { ...actual, getDb: () => ({}) };
  });
  vi.doMock("@/lib/oauth/mcp-servers", () => ({
    getMcpProviderExecutionStatus: () => ({ executionConfigured: true }),
    loadUserMcpProviderStatus: async () => ({ providerAvailability }),
  }));
}

beforeEach(() => {
  providerAvailability = {};
});

afterEach(() => {
  vi.resetModules();
});

describe("GET /api/oauth/status", () => {
  it("reports active providers as ready and absent providers as disconnected", async () => {
    providerAvailability = {
      github: readyAvailability(),
      notion: readyAvailability(),
    };
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
          executionConfigured: true,
          toolAvailable: false,
          status: "not_connected",
        },
      },
    });
  });

  it("reports an under-scoped Google grant as requiring reconnect", async () => {
    providerAvailability = {
      google: {
        connected: true,
        tokenValid: false,
        userApproved: true,
        executionConfigured: true,
        toolMountable: false,
        modelAvailable: false,
        status: "reconnect_required",
        reason: "insufficient_scope",
      },
    };
    installMocks();
    const { GET } = await import("@/app/api/oauth/status/route");

    const res = await GET();
    await expect(res.json()).resolves.toMatchObject({
      google: true,
      providerDetails: {
        google: {
          connected: true,
          executionConfigured: true,
          toolAvailable: false,
          status: "reconnect_required",
          reason: "insufficient_scope",
        },
      },
    });
  });
});

function readyAvailability() {
  return {
    connected: true,
    tokenValid: true,
    userApproved: true,
    executionConfigured: true,
    toolMountable: true,
    modelAvailable: true,
    status: "ready",
  };
}
