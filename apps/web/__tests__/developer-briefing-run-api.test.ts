import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";
import {
  estimateUsageCostUsd,
  type RunBudgetReceipt,
  type TokenUsage,
} from "@ai-workspace/agent";

const sessionUser: SessionUser = {
  id: "user-uuid",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

let insertedRuns: Array<Record<string, unknown>> = [];
let runUpdates: Array<Record<string, unknown>> = [];
let registryCalls: string[] = [];
// Read lazily by the mock factories so a test can mount GitHub and script the
// runtime without re-registering the module mocks.
let githubServer: unknown;
let runtime: unknown = { name: "local" };

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
    buildUserMcpServers: async () => ({
      mcpServers: githubServer ? { github: githubServer } : {},
      deniedProviders: [],
      toolPolicyDecisions: {},
    }),
  }));

  vi.doMock("@/lib/run-events", () => ({
    appendRunEvent: async () => undefined,
    appendToolCallRunEvent: async () => undefined,
    appendToolResultRunEvent: async () => undefined,
  }));

  vi.doMock("@ai-workspace/agent-runtime", () => ({
    getRuntime: () => runtime,
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
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          if (table === actual.runs) runUpdates.push(values);
          return { where: async () => undefined };
        },
      }),
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
    runUpdates = [];
    registryCalls = [];
    githubServer = undefined;
    runtime = { name: "local" };
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
    expect(insertedRuns[0]!.inputs).toMatchObject({
      runBudget: {
        envelope: {
          schema: "comparative.run-budget.v1",
          version: 1,
          governingLayer: "organization",
          limits: {
            tokens: 1_000_000,
            usd: 10,
            wallClockMs: 3_600_000,
            toolIterations: 8,
          },
        },
      },
    });
  });

  it("keeps an enabled requested model", async () => {
    await postRun({ modelId: "sonnet-4-6" });

    expect(registryCalls).toContain("enabled:sonnet-4-6:durable-local");
    expect(registryCalls).not.toContain("resolve:durable-local");
    expect(insertedRuns).toHaveLength(1);
    expect(insertedRuns[0]!.modelId).toBe("sonnet-4-6");
  });

  it("#848: a failed briefing persists a receipt consistent with its usage", async () => {
    const usage: TokenUsage = {
      tokensIn: 1_200,
      tokensOut: 300,
      inputTokens: 1_200,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    };
    githubServer = { url: "https://example.test/mcp" };
    runtime = {
      name: "local",
      runTurn: async function* () {
        yield { type: "text-delta", delta: "partial briefing" };
        yield { type: "usage", ...usage };
        yield { type: "error", message: "provider exploded" };
      },
    };

    const res = await postRun({ modelId: "sonnet-4-6" });

    expect(res.status).toBe(500);
    const failed = runUpdates.find((update) => update.status === "failed");
    const outputs = failed?.outputs as {
      usage: TokenUsage;
      budgetReceipt: RunBudgetReceipt;
    };
    expect(outputs.usage).toEqual(usage);
    expect(outputs.budgetReceipt.partial).toBe(false);
    expect(outputs.budgetReceipt.consumed.tokens).toBe(
      usage.tokensIn + usage.tokensOut,
    );
    expect(outputs.budgetReceipt.consumed.usd).toBeCloseTo(
      estimateUsageCostUsd("sonnet-4-6", usage),
      12,
    );
  });
});
