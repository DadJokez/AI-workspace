import { describe, expect, it } from "vitest";
import {
  parseSkillMarkdown,
  serializeSkillToMarkdown,
} from "@/lib/skill-format";
import { STARTER_SKILLS } from "@/lib/starter-skills";

/** ADR 0002 — SKILL.md ↔ row converter. */
describe("parseSkillMarkdown", () => {
  it("parses frontmatter + body into a skill row", () => {
    const md = [
      "---",
      "name: weekly-status",
      "description: Drafts a weekly status update from GitHub activity.",
      "model: sonnet-4-6",
      "mcp_providers: [github]",
      "---",
      "You draft the user's weekly status from their GitHub activity.",
    ].join("\n");
    const result = parseSkillMarkdown(md);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.slug).toBe("weekly-status");
    expect(result.skill.description).toMatch(/weekly status/i);
    expect(result.skill.modelId).toBe("sonnet-4-6");
    expect(result.skill.mcpProviders).toEqual(["github"]);
    expect(result.skill.systemPrompt).toContain("You draft");
    expect(result.skill.warnings).toEqual([]);
  });

  it("defaults model and drops unsupported providers with a warning", () => {
    const md = [
      "---",
      "name: my-skill",
      "description: does a thing",
      "mcp_providers: [github, workfront]",
      "---",
      "Do the thing.",
    ].join("\n");
    const result = parseSkillMarkdown(md);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.modelId).toBe("sonnet-4-5"); // DEFAULT_MODEL_ID
    expect(result.skill.mcpProviders).toEqual(["github"]);
    expect(result.skill.warnings.join(" ")).toMatch(/workfront/);
  });

  it("accepts Salesforce as a supported provider in skill frontmatter", () => {
    const md = [
      "---",
      "name: pipeline-summary",
      "description: Summarizes open pipeline.",
      "mcp_providers: [salesforce]",
      "---",
      "Use read-only Salesforce context to summarize open pipeline.",
    ].join("\n");
    const result = parseSkillMarkdown(md);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.mcpProviders).toEqual(["salesforce"]);
    expect(result.skill.warnings).toEqual([]);
  });

  it("accepts Notion as a supported provider in skill frontmatter", () => {
    const md = [
      "---",
      "name: notion-summary",
      "description: Summarizes Notion docs.",
      "mcp_providers: [notion]",
      "---",
      "Use Notion context to summarize workspace docs.",
    ].join("\n");

    const result = parseSkillMarkdown(md);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.mcpProviders).toEqual(["notion"]);
    expect(result.skill.warnings).toEqual([]);
  });

  it("rejects missing frontmatter, name, description, or body", () => {
    expect(parseSkillMarkdown("just text").ok).toBe(false);
    expect(
      parseSkillMarkdown("---\ndescription: x\n---\nbody").ok,
    ).toBe(false); // no name
    expect(parseSkillMarkdown("---\nname: x\n---\nbody").ok).toBe(false); // no description
    expect(
      parseSkillMarkdown("---\nname: x\ndescription: y\n---\n   ").ok,
    ).toBe(false); // empty body
  });

  it("flags unknown frontmatter keys as warnings, not errors", () => {
    const md = [
      "---",
      "name: x",
      "description: y",
      "globs: '*.ts'",
      "---",
      "body",
    ].join("\n");
    const result = parseSkillMarkdown(md);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.warnings.join(" ")).toMatch(/globs/);
  });
});

describe("serializeSkillToMarkdown round-trip", () => {
  it("serializes a row back to SKILL.md that re-parses identically", () => {
    const md = serializeSkillToMarkdown({
      slug: "executive-brief",
      description: "One-page executive brief from any long document.",
      systemPrompt: "You compress long material into a one-page brief.",
      modelId: "sonnet-4-6",
      mcpProviders: ["github"],
    });
    const reparsed = parseSkillMarkdown(md);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.skill.slug).toBe("executive-brief");
    expect(reparsed.skill.modelId).toBe("sonnet-4-6");
    expect(reparsed.skill.mcpProviders).toEqual(["github"]);
    expect(reparsed.skill.systemPrompt).toContain("one-page brief");
  });

  it("round-trips web access as an explicit portable declaration", () => {
    const markdown = serializeSkillToMarkdown({
      slug: "nightly-research",
      description: "Research overnight.",
      systemPrompt: "Research the requested topic.",
      modelId: "sonnet-4-6",
      mcpProviders: ["github", "web"],
    });

    expect(markdown).toContain("mcp_providers: [github]");
    expect(markdown).toContain("web_access: true");
    const reparsed = parseSkillMarkdown(markdown);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.skill.mcpProviders).toEqual(["github", "web"]);
  });

  it.each(["meeting-prep", "weekly-status"])(
    "round-trips the %s starter without losing providers or instructions",
    (slug) => {
      const starter = STARTER_SKILLS.find((skill) => skill.slug === slug);
      expect(starter).toBeDefined();
      if (!starter) return;

      const reparsed = parseSkillMarkdown(serializeSkillToMarkdown(starter));

      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) return;
      expect(reparsed.skill.slug).toBe(starter.slug);
      expect(reparsed.skill.modelId).toBe(starter.modelId);
      expect(reparsed.skill.mcpProviders).toEqual(starter.mcpProviders);
      expect(reparsed.skill.systemPrompt).toBe(starter.systemPrompt);
    },
  );
});
