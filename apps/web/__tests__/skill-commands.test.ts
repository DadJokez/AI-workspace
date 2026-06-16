import { describe, expect, it } from "vitest";
import { isValidModelId } from "@ai-workspace/agent";
import {
  filterSkillsForCommand,
  isSlashCommand,
  slashQuery,
} from "@/lib/skill-commands";
import { SUPPORTED_MCP_PROVIDERS } from "@/lib/oauth/mcp-servers";
import { STARTER_SKILLS } from "@/lib/starter-skills";

const SKILLS = [
  {
    id: "1",
    slug: "developer-briefing",
    name: "Developer Briefing",
    description: "PRs, reviews, CI",
    mcpProviders: ["github"],
  },
  {
    id: "2",
    slug: "weekly-status",
    name: "Weekly Status",
    description: "Week in review",
    mcpProviders: ["github"],
  },
  {
    id: "3",
    slug: "email-drafter",
    name: "Email Drafter",
    description: "Professional email from rough notes",
    mcpProviders: [],
  },
];

/** #144 — slash-command matching for the chat palette. */
describe("skill-commands", () => {
  it("detects slash commands and strips noise tokens", () => {
    expect(isSlashCommand("/skills")).toBe(true);
    expect(isSlashCommand("  /run weekly")).toBe(true);
    expect(isSlashCommand("hello /skills")).toBe(false);
    expect(slashQuery("/skills developer briefing")).toBe("developer briefing");
    expect(slashQuery("/run weekly status")).toBe("weekly status");
    expect(slashQuery("/")).toBe("");
  });

  it("resolves Rob's exact first attempt to the right skill", () => {
    const matches = filterSkillsForCommand("/skills developer briefing", SKILLS);
    expect(matches[0]?.slug).toBe("developer-briefing");
  });

  it("treats generic output words as aliases in multi-word commands", () => {
    const matches = filterSkillsForCommand("/weekly brief", SKILLS);
    expect(matches[0]?.slug).toBe("weekly-status");
  });

  it("empty query lists everything; words filter across name and description", () => {
    expect(filterSkillsForCommand("/", SKILLS)).toHaveLength(3);
    expect(
      filterSkillsForCommand("/email", SKILLS).map((s) => s.slug),
    ).toEqual(["email-drafter"]);
    expect(
      filterSkillsForCommand("/rough notes", SKILLS).map((s) => s.slug),
    ).toEqual(["email-drafter"]);
    expect(filterSkillsForCommand("/zzz", SKILLS)).toHaveLength(0);
  });

  it("ranks name matches above description-only matches", () => {
    const matches = filterSkillsForCommand("/status", SKILLS);
    expect(matches[0]?.slug).toBe("weekly-status");
  });
});

describe("STARTER_SKILLS", () => {
  it("ships the corporate starter pack with unique, valid definitions", () => {
    expect(STARTER_SKILLS.length).toBeGreaterThanOrEqual(7);
    const slugs = STARTER_SKILLS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const starter of STARTER_SKILLS) {
      expect(starter.name.length).toBeGreaterThan(0);
      expect(starter.systemPrompt.length).toBeGreaterThan(40);
      expect(isValidModelId(starter.modelId)).toBe(true);
      for (const provider of starter.mcpProviders) {
        expect(SUPPORTED_MCP_PROVIDERS).toContain(provider);
      }
    }
  });

  it("keeps zero-provider starters runnable before more integrations land", () => {
    const zeroProvider = STARTER_SKILLS.filter(
      (s) => s.mcpProviders.length === 0,
    );
    expect(zeroProvider.length).toBeGreaterThanOrEqual(5);
  });
});
