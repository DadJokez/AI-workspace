import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

const session: SessionUser = {
  id: "user-empty-state",
  email: "rob@example.com",
  displayName: "Rob",
  role: "user",
};

let currentSession: SessionUser | null = session;
let customInstructions: string | null = "My role: Engineering.";
let providerUserIds: string[] = [];

function installMocks() {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => currentSession,
  }));
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    return {
      ...actual,
      getDb: () => ({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [{ customInstructions }],
            }),
          }),
        }),
      }),
    };
  });
  vi.doMock("@/lib/oauth/mcp-servers", () => ({
    loadUserMcpProviderStatus: async (_db: unknown, userId: string) => {
      providerUserIds.push(userId);
      return {
        connectedProviders: ["github"],
        allowedProviders: ["github"],
      };
    },
  }));
}

beforeEach(() => {
  currentSession = session;
  customInstructions = "My role: Engineering.";
  providerUserIds = [];
});

afterEach(() => {
  vi.resetModules();
});

describe("GET /api/recommendations/prompts", () => {
  it("returns role-aware prompts and connections for the signed-in user", async () => {
    installMocks();
    const { GET } = await import("@/app/api/recommendations/prompts/route");

    const response = await GET();

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      connectedProviders: string[];
      suggestions: string[];
    };
    expect(body.connectedProviders).toEqual(["github"]);
    expect(body.suggestions).toHaveLength(4);
    expect(body.suggestions[0]).toBe(
      "Review my open GitHub work and tell me what to tackle first",
    );
    expect(providerUserIds).toEqual([session.id]);
  });

  it("rejects anonymous requests before loading provider state", async () => {
    currentSession = null;
    installMocks();
    const { GET } = await import("@/app/api/recommendations/prompts/route");

    const response = await GET();

    expect(response.status).toBe(401);
    expect(providerUserIds).toEqual([]);
  });
});
