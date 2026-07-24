import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

/**
 * Skills spine tests (specs/002-skills-spine T208): pure helpers plus
 * route-level authz/validation with the same mocked-db harness the other
 * API tests use.
 */

const owner: SessionUser = {
  id: "owner-uuid",
  email: "owner@example.com",
  displayName: "Owner",
  role: "user",
};

const stranger: SessionUser = {
  id: "stranger-uuid",
  email: "stranger@example.com",
  displayName: "Stranger",
  role: "user",
};

const admin: SessionUser = {
  id: "admin-uuid",
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin",
};

interface DbHooks {
  insertReturning?: Array<Record<string, unknown>>;
  selectRows?: Array<Record<string, unknown>>;
  /** When set, each select terminal (limit/orderBy) consumes the next entry. */
  selectQueue?: Array<Array<Record<string, unknown>>>;
  onInsertValues?: (values: Record<string, unknown>) => void;
  onUpdateSet?: (values: Record<string, unknown>) => void;
}

let dbHooks: DbHooks = {};

function setSession(user: SessionUser | null) {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => user,
  }));
}

function installDbMock() {
  // #300: routes consult the registry for chat-enabled models; the fixture
  // registry keeps all three tiers enabled like the seeded production state.
  vi.doMock("@/lib/model-registry", () => ({
    enabledModelsForPurpose: async () => [
      "sonnet-4-5",
      "haiku-4-5",
      "sonnet-4-6",
      "opus-4-7",
    ],
    isModelEnabled: async (_db: unknown, id: string) =>
      ["sonnet-4-5", "haiku-4-5", "sonnet-4-6", "opus-4-7"].includes(id),
    resolveModelForPurpose: async () => "sonnet-4-6",
  }));

  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );

    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return undefined;
          if (prop === "values") {
            return (v: Record<string, unknown>) => {
              dbHooks.onInsertValues?.(v);
              return proxy;
            };
          }
          if (prop === "set") {
            return (v: Record<string, unknown>) => {
              dbHooks.onUpdateSet?.(v);
              return proxy;
            };
          }
          if (prop === "returning") {
            return () => Promise.resolve(dbHooks.insertReturning ?? []);
          }
          if (prop === "orderBy" || prop === "limit") {
            return () =>
              Promise.resolve(
                dbHooks.selectQueue
                  ? (dbHooks.selectQueue.shift() ?? [])
                  : (dbHooks.selectRows ?? []),
              );
          }
          return () => proxy;
        },
      },
    );

    return {
      ...actual,
      getDb: () => proxy as never,
    };
  });
}

afterEach(() => {
  dbHooks = {};
  vi.doUnmock("@/lib/oauth/mcp-servers");
  vi.doUnmock("@/lib/skills-naming-gate");
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("skills helpers", () => {
  it("slugifies names into url-safe slugs", async () => {
    const { slugifySkillName } = await import("@/lib/skills");
    expect(slugifySkillName("Morning Briefing")).toBe("morning-briefing");
    expect(slugifySkillName("  Data → Insights!! ")).toBe("data-insights");
    expect(slugifySkillName("!!!")).toBe("skill");
  });

  it("builds the turn prompt around the skill's instructions", async () => {
    const { buildSkillTurnPrompt } = await import("@/lib/skills");
    const prompt = buildSkillTurnPrompt({
      name: "Weekly Status",
      systemPrompt: "Summarize my week.",
    });
    expect(prompt).toContain('saved skill "Weekly Status"');
    expect(prompt).toContain("Summarize my week.");
  });

  it("keeps only the user's request in the model-visible message (#416)", async () => {
    const { buildActivatedSkillUserMessage } = await import("@/lib/skills");
    // The skill body pins into the stable system prefix via the context
    // pack; the summarizable message stream carries user content only.
    expect(buildActivatedSkillUserMessage("focus on launch work")).toBe(
      "focus on launch work",
    );
    expect(buildActivatedSkillUserMessage("   ")).toBe(
      "Run this skill using the available conversation context.",
    );
  });

  it("keeps the visible skill-run message user-facing", async () => {
    const { buildSkillDisplayMessage } = await import("@/lib/skills");
    expect(buildSkillDisplayMessage({ name: "Weekly Status" })).toBe(
      "Run Weekly Status",
    );
  });

  it("blocks skills while providers need reconnecting or are temporarily unavailable", async () => {
    vi.doMock("@/lib/oauth/mcp-servers", async () => {
      const actual =
        await vi.importActual<typeof import("@/lib/oauth/mcp-servers")>(
          "@/lib/oauth/mcp-servers",
        );
      return {
        ...actual,
        loadUserMcpProviderStatus: vi.fn(async () => ({
          connectedProviders: ["github", "google"],
          allowedProviders: [],
          deniedProviders: [],
          executionUnavailableProviders: [],
          reconnectRequiredProviders: ["google"],
          providerAvailability: {
            google: {
              status: "reconnect_required",
            },
            github: {
              status: "temporarily_unavailable",
            },
          },
        })),
      };
    });
    const {
      checkSkillProviderAccess,
      isSkillProviderAccessReady,
    } = await import("@/lib/skills");

    const access = await checkSkillProviderAccess(
      {} as never,
      owner.id,
      ["github", "google"],
    );

    expect(access.reconnectRequired).toEqual(["google"]);
    expect(access.temporarilyUnavailable).toEqual(["github"]);
    expect(isSkillProviderAccessReady(access)).toBe(false);
  });

  it("enforces visibility: owner, starter, admin", async () => {
    const { canViewSkill, canRunSkill } = await import("@/lib/skills");
    const base = {
      ownerUserId: owner.id,
      isStarter: false,
      archivedAt: null,
    };

    expect(canViewSkill(base, owner)).toBe(true);
    expect(canViewSkill(base, stranger)).toBe(false);
    expect(canViewSkill(base, admin)).toBe(true);
    expect(canViewSkill({ ...base, isStarter: true }, stranger)).toBe(true);
    // Archived starters disappear for non-owners but stay visible to owners.
    expect(
      canViewSkill({ ...base, isStarter: true, archivedAt: new Date() }, stranger),
    ).toBe(false);
    expect(
      canViewSkill({ ...base, archivedAt: new Date() }, owner),
    ).toBe(true);
    // Archived skills are never runnable, even by their owner.
    expect(canRunSkill({ ...base, archivedAt: new Date() }, owner)).toBe(false);
  });

  it("validates and normalizes skill input", async () => {
    const { parseSkillInput } = await import("@/lib/skills");

    const ok = parseSkillInput({
      name: "  Briefing  ",
      systemPrompt: "Do the thing.",
      mcpProviders: ["github", "github"],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.input.name).toBe("Briefing");
      expect(ok.input.mcpProviders).toEqual(["github"]);
      expect(ok.input.modelId).toBeTruthy();
    }

    const notion = parseSkillInput({
      name: "Notion Briefing",
      systemPrompt: "Summarize the docs.",
      mcpProviders: ["notion"],
    });
    expect(notion.ok).toBe(true);
    if (notion.ok) {
      expect(notion.input.mcpProviders).toEqual(["notion"]);
    }

    const web = parseSkillInput({
      name: "Research Briefing",
      systemPrompt: "Research the topic.",
      mcpProviders: ["web"],
    });
    expect(web.ok).toBe(true);
    if (web.ok) {
      expect(web.input.mcpProviders).toEqual(["web"]);
    }

    const badProvider = parseSkillInput({
      name: "X",
      systemPrompt: "Y",
      mcpProviders: ["sap-erp"],
    });
    expect(badProvider.ok).toBe(false);
    if (!badProvider.ok) expect(badProvider.error.field).toBe("mcpProviders");

    const badModel = parseSkillInput({
      name: "X",
      systemPrompt: "Y",
      modelId: "gpt-100",
    });
    expect(badModel.ok).toBe(false);
    if (!badModel.ok) expect(badModel.error.field).toBe("modelId");

    const missingPrompt = parseSkillInput({ name: "X" });
    expect(missingPrompt.ok).toBe(false);
    if (!missingPrompt.ok) expect(missingPrompt.error.field).toBe("systemPrompt");
  });

  it("rejects pinning a registered-but-disabled model (#300)", async () => {
    const { parseSkillInput } = await import("@/lib/skills");
    const enabledModelIds = new Set(["haiku-4-5", "sonnet-4-6"]);

    const disabled = parseSkillInput(
      { name: "X", systemPrompt: "Y", modelId: "opus-4-7" },
      { enabledModelIds },
    );
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) {
      expect(disabled.error.field).toBe("modelId");
      expect(disabled.error.message).toMatch(/not enabled/i);
    }

    const enabled = parseSkillInput(
      { name: "X", systemPrompt: "Y", modelId: "sonnet-4-6" },
      { enabledModelIds },
    );
    expect(enabled.ok).toBe(true);
  });
});

describe("POST /api/skills", () => {
  function makeReq(body: unknown) {
    return new Request("http://localhost/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when there is no session", async () => {
    setSession(null);
    installDbMock();
    const { POST } = await import("@/app/api/skills/route");
    const res = await POST(makeReq({ name: "X", systemPrompt: "Y" }));
    expect(res.status).toBe(401);
  });

  it("rejects invalid input with a field-level error", async () => {
    setSession(owner);
    installDbMock();
    const { POST } = await import("@/app/api/skills/route");
    const res = await POST(makeReq({ name: "", systemPrompt: "Y" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe("invalid_skill");
    expect(body.field).toBe("name");
  });

  it("creates a skill owned by the caller and audits it", async () => {
    setSession(owner);
    const inserted: Array<Record<string, unknown>> = [];
    dbHooks.onInsertValues = (values) => inserted.push(values);
    dbHooks.insertReturning = [
      {
        id: "skill-1",
        slug: "briefing",
        name: "Briefing",
        ownerUserId: owner.id,
        modelId: "sonnet-4-6",
        mcpProviders: ["github"],
      },
    ];
    installDbMock();

    const { POST } = await import("@/app/api/skills/route");
    const res = await POST(
      makeReq({
        name: "Briefing",
        systemPrompt: "Do the thing.",
        mcpProviders: ["github"],
        modelId: "sonnet-4-6",
      }),
    );
    expect(res.status).toBe(201);

    const skillInsert = inserted.find((v) => v.systemPrompt);
    expect(skillInsert).toBeDefined();
    expect(skillInsert!.ownerUserId).toBe(owner.id);
    expect(skillInsert!.mcpProviders).toEqual(["github"]);

    const auditInsert = inserted.find((v) => v.actionType === "skill_create");
    expect(auditInsert).toBeDefined();
    expect(auditInsert!.actorUserId).toBe(owner.id);
  });
});

describe("POST /api/skills/[id]/clone", () => {
  it("404s when the skill is not visible to the caller", async () => {
    setSession(stranger);
    dbHooks.selectQueue = [
      // 1) the skill lookup finds a private skill owned by someone else
      [
        {
          id: "skill-1",
          slug: "private-skill",
          name: "Private",
          ownerUserId: owner.id,
          isStarter: false,
          archivedAt: null,
          systemPrompt: "secret",
          modelId: "sonnet-4-6",
          mcpProviders: [],
        },
      ],
      // 2) the share lookup finds no active grant
      [],
    ];
    installDbMock();

    const { POST } = await import("@/app/api/skills/[id]/clone/route");
    const res = await POST(new Request("http://localhost/api/skills/skill-1/clone", { method: "POST" }), {
      params: Promise.resolve({ id: "skill-1" }),
    });
    expect(res.status).toBe(404);
  });

  it("clones a starter for a non-owner with provenance", async () => {
    setSession(stranger);
    const inserted: Array<Record<string, unknown>> = [];
    dbHooks.onInsertValues = (values) => inserted.push(values);
    dbHooks.selectRows = [
      {
        id: "skill-1",
        slug: "developer-briefing",
        name: "Developer Briefing",
        description: "Starter",
        ownerUserId: owner.id,
        isStarter: true,
        archivedAt: null,
        systemPrompt: "Brief me.",
        modelId: "sonnet-4-6",
        mcpProviders: ["github"],
      },
    ];
    dbHooks.insertReturning = [
      { id: "clone-1", slug: "developer-briefing-abc123", name: "Developer Briefing" },
    ];
    installDbMock();

    const { POST } = await import("@/app/api/skills/[id]/clone/route");
    const res = await POST(new Request("http://localhost/api/skills/skill-1/clone", { method: "POST" }), {
      params: Promise.resolve({ id: "skill-1" }),
    });
    expect(res.status).toBe(201);

    const cloneInsert = inserted.find((v) => v.clonedFromSkillId === "skill-1");
    expect(cloneInsert).toBeDefined();
    expect(cloneInsert!.ownerUserId).toBe(stranger.id);
    expect(cloneInsert!.isStarter).toBe(false);
  });
});

describe("PATCH /api/skills/[id]", () => {
  it("preserves the stored model while the platform override is active", async () => {
    setSession(owner);
    const updates: Array<Record<string, unknown>> = [];
    dbHooks.selectRows = [
      {
        id: "skill-1",
        slug: "briefing",
        name: "Briefing",
        description: "Original",
        ownerUserId: owner.id,
        isStarter: false,
        archivedAt: null,
        systemPrompt: "Brief me.",
        modelId: "haiku-4-5",
        mcpProviders: [],
      },
    ];
    dbHooks.onUpdateSet = (values) => updates.push(values);
    dbHooks.insertReturning = [
      {
        id: "skill-1",
        slug: "briefing",
        modelId: "haiku-4-5",
      },
    ];
    vi.doMock("@/lib/skills-naming-gate", () => ({
      evaluateSkillNamingGate: async () => null,
    }));
    installDbMock();

    const { PATCH } = await import("@/app/api/skills/[id]/route");
    const res = await PATCH(
      new Request("http://localhost/api/skills/skill-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Briefing",
          description: "Updated",
          systemPrompt: "Brief me with more detail.",
          modelId: "sonnet-4-5",
          mcpProviders: [],
        }),
      }),
      { params: Promise.resolve({ id: "skill-1" }) },
    );

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      description: "Updated",
      modelId: "haiku-4-5",
    });
  });
});
