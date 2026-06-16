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
}

let dbHooks: DbHooks = {};

function setSession(user: SessionUser | null) {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => user,
  }));
}

function installDbMock() {
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

  it("keeps the visible skill-run message user-facing", async () => {
    const { buildSkillDisplayMessage } = await import("@/lib/skills");
    expect(buildSkillDisplayMessage({ name: "Weekly Status" })).toBe(
      "Run Weekly Status",
    );
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
