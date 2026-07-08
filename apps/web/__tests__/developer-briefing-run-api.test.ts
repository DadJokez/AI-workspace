import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

const sessionUser: SessionUser = {
  id: "user-uuid",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

let insertedRuns: Array<Record<string, unknown>> = [];
let registryCalls: string[] = [];

function makeReq(body: unknown) {
  return new Request("http://localhost/api/workflows/developer-briefing/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function installMocks() {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => sessionUser,
  }));

  // #300: the route resolves the requested model through the registry.
  vi.doMock("@/lib/model-registry", () => ({
    isModelEnabled: async (_db: unknown, id: string, purpose: string) => {
      registryCalls.push(`enabled:${id}:${purpose}`);
      return id === "sonnet-4-6";
    },
    resolveModelForPurpose: async (_db: unknown, purpose: string) => {
      registryCalls.push(`resolve:${purpose}`);
      return "haiku-4-5";
    },
  }));

  vi.doMock("@/lib/request-limits", () => ({
    requestLimitConfig: () => ({
      windowMs: 60_000,
      maxRequests: 30,
      maxRequestBytes: 1024 * 1024,
    }),
    contentLengthTooLarge: () => false,
    checkRateLimit: async () => ({
      allowed: true,
      limit: 10,
      remaining: 9,
      resetAt: new Date(),
      retryAfterSeconds: 0,
    }),
  }));

  // No GitHub server: the handler persists the run, then fails before the
  // model is ever invoked — the earliest observable point for the gate.
  vi.doMock("@/lib/oauth/mcp-servers", () => ({
    buildUserMcpServers: async () => ({ mcpServers: {}, deniedProviders: [] }),
  }));

  vi.doMock("@/lib/run-events", () => ({
    appendRunEvent: async () => undefined,
    appendToolCallRunEvent: async () => undefined,
    appendToolResultRunEvent: async () => undefined,
  }));

  vi.doMock("@ai-workspace/agent-runtime", () => ({
    getRuntime: () => ({ name: "local" }),
  }));

  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    const db = {
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          if (table === actual.runs) insertedRuns.push(values);
          const result = Promise.resolve(undefined) as Promise<unknown> & {
            returning: () => Promise<unknown[]>;
          };
          result.returning = async () => [{ ...values, id: "run-1" }];
          return result;
        },
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    return { ...actual, getDb: () => db };
  });
}

async function postRun(body: unknown) {
  const route = await import(
    "@/app/api/workflows/developer-briefing/run/route"
  );
  return route.POST(makeReq(body));
}

describe("developer briefing run route model gating", () => {
  beforeEach(() => {
    vi.resetModules();
    insertedRuns = [];
    registryCalls = [];
    installMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves a disabled or unknown model before persisting the run", async () => {
    const res = await postRun({ modelId: "bogus-model" });

    expect(res.status).toBe(400);
    expect(registryCalls).toContain("enabled:bogus-model:durable-local");
    expect(registryCalls).toContain("resolve:durable-local");
    expect(insertedRuns).toHaveLength(1);
    expect(insertedRuns[0]!.modelId).toBe("haiku-4-5");
  });

  it("keeps an enabled requested model", async () => {
    await postRun({ modelId: "sonnet-4-6" });

    expect(registryCalls).toContain("enabled:sonnet-4-6:durable-local");
    expect(registryCalls).not.toContain("resolve:durable-local");
    expect(insertedRuns).toHaveLength(1);
    expect(insertedRuns[0]!.modelId).toBe("sonnet-4-6");
  });
});
