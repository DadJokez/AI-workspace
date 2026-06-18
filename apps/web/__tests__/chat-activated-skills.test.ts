import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";
import type { Database, Skill } from "@ai-workspace/db";
import { resolveActivatedSkillForChat } from "@/lib/chat-activated-skills";

const actor: SessionUser = {
  id: "user-1",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

const skill = {
  id: "skill-1",
  slug: "weekly-status",
  name: "Weekly Status",
  description: "Draft a weekly status update.",
  systemPrompt: "Write the status.",
  modelId: "sonnet-4-6",
  mcpProviders: ["github"],
  ownerUserId: actor.id,
  isStarter: false,
  archivedAt: null,
} as unknown as Skill;

describe("resolveActivatedSkillForChat", () => {
  it("returns no activation when the request carries no activated skills", async () => {
    const result = await resolveActivatedSkillForChat({
      db: dbWithSkills([]),
      actor,
      activatedSkills: undefined,
    });

    expect(result).toEqual({ ok: true, activatedSkill: null });
  });

  it("rejects multiple activated skills in one turn", async () => {
    const result = await resolveActivatedSkillForChat({
      db: dbWithSkills([]),
      actor,
      activatedSkills: [
        { id: "skill-1", source: "explicit" },
        { id: "skill-2", source: "explicit" },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "invalid_activated_skills",
    });
  });

  it("rejects non-explicit activation sources from the client", async () => {
    const result = await resolveActivatedSkillForChat({
      db: dbWithSkills([]),
      actor,
      activatedSkills: [{ id: "skill-1", source: "automatic" }],
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "invalid_activated_skill_source",
    });
  });

  it("returns 404 when the actor cannot run the selected skill", async () => {
    const result = await resolveActivatedSkillForChat({
      db: dbWithSkills([skill]),
      actor,
      activatedSkills: [{ id: skill.id, source: "explicit" }],
      deps: {
        canRunSkill: vi.fn(async () => false),
        checkProviderAccess: vi.fn(),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      error: "skill_not_found",
    });
  });

  it("returns 409 when the selected skill needs unavailable providers", async () => {
    const result = await resolveActivatedSkillForChat({
      db: dbWithSkills([skill]),
      actor,
      activatedSkills: [
        {
          id: skill.id,
          source: "explicit",
          args: " focus this week ",
        },
      ],
      deps: {
        canRunSkill: vi.fn(async () => true),
        checkProviderAccess: vi.fn(async () => ({
          ready: [],
          missingConnections: ["github"],
          deniedAttestations: [],
        })),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: "skill_provider_unavailable",
      message: expect.stringContaining("connect github"),
    });
  });

  it("returns the skill and trimmed args when access and providers are valid", async () => {
    const result = await resolveActivatedSkillForChat({
      db: dbWithSkills([skill]),
      actor,
      activatedSkills: [
        {
          id: skill.id,
          source: "explicit",
          args: " focus this week ",
        },
      ],
      deps: {
        canRunSkill: vi.fn(async () => true),
        checkProviderAccess: vi.fn(async () => ({
          ready: ["github"],
          missingConnections: [],
          deniedAttestations: [],
        })),
      },
    });

    expect(result).toMatchObject({
      ok: true,
      activatedSkill: {
        skill,
        args: "focus this week",
      },
    });
  });

  it("uses the canonical starter definition for stale seeded skills", async () => {
    const staleStarter = {
      ...skill,
      id: "starter-weekly",
      ownerUserId: "admin-user",
      isStarter: true,
      systemPrompt: "Old prompt from an earlier seed.",
      mcpProviders: [],
    } as unknown as Skill;
    const checkProviderAccess = vi.fn(async () => ({
      ready: ["github"],
      missingConnections: [],
      deniedAttestations: [],
    }));

    const result = await resolveActivatedSkillForChat({
      db: dbWithSkills([staleStarter]),
      actor,
      activatedSkills: [
        {
          id: staleStarter.id,
          source: "explicit",
        },
      ],
      deps: {
        canRunSkill: vi.fn(async () => true),
        checkProviderAccess,
      },
    });

    expect(checkProviderAccess).toHaveBeenCalledWith(
      expect.anything(),
      actor.id,
      ["github"],
    );
    expect(result).toMatchObject({
      ok: true,
      activatedSkill: {
        skill: {
          id: staleStarter.id,
          slug: "weekly-status",
          systemPrompt: expect.stringContaining(
            "Use the GitHub tools before writing",
          ),
          mcpProviders: ["github"],
        },
      },
    });
  });
});

function dbWithSkills(rows: Skill[]): Database {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => rows,
  };
  return {
    select: () => chain,
  } as unknown as Database;
}
