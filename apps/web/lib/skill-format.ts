import { DEFAULT_MODEL_ID, isValidModelId } from "@ai-workspace/agent";
import { SUPPORTED_MCP_PROVIDERS } from "@/lib/oauth/mcp-servers";
import {
  SKILL_WEB_ACCESS_DECLARATION,
  skillDeclaresWebAccess,
  skillMcpProviders,
} from "@/lib/skill-tool-declarations";

/**
 * SKILL.md ↔ skill row converter (ADR 0002). The database row is the runtime
 * source of truth; this is the portable interchange/authoring format, using
 * the Anthropic Agent Skills convention (YAML frontmatter + Markdown body)
 * plus our additive `model` / `mcp_providers` extensions.
 *
 * Intentionally a tiny, dependency-free YAML reader — we only support the flat
 * scalar + simple-list subset a SKILL.md frontmatter actually uses, so we
 * don't pull a full YAML parser into the bundle.
 */

export interface ParsedSkillMarkdown {
  name: string;
  slug: string;
  description: string | null;
  systemPrompt: string;
  modelId: string;
  mcpProviders: string[];
  /** Non-fatal notes (unknown keys, dropped resources) for the importer UI. */
  warnings: string[];
}

export interface SkillFormatError {
  ok: false;
  error: string;
}

const SLUG_RE = /[^a-z0-9]+/g;

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(SLUG_RE, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "skill"
  );
}

function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Parse a simple-list scalar: `[a, b]` or `a, b` → ["a","b"]. */
function parseList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function stripQuotes(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

/**
 * Parse a SKILL.md document into a skill row shape. Returns an error for a
 * missing/invalid frontmatter or an empty body.
 */
export function parseSkillMarkdown(
  markdown: string,
): { ok: true; skill: ParsedSkillMarkdown } | SkillFormatError {
  const warnings: string[] = [];
  const fmMatch = markdown.match(/^\s*---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!fmMatch) {
    return {
      ok: false,
      error:
        "Missing YAML frontmatter. A SKILL.md must start with a --- block containing at least `name` and `description`.",
    };
  }

  const [, frontmatter, body] = fmMatch;
  const fields: Record<string, string> = {};
  for (const line of frontmatter!.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    fields[m[1]!.toLowerCase()] = m[2]!;
  }

  const rawName = fields.name ? stripQuotes(fields.name) : "";
  if (!rawName) {
    return { ok: false, error: "Frontmatter is missing the required `name`." };
  }
  const slug = slugify(rawName);
  const name = /[A-Z\s]/.test(rawName) ? rawName.slice(0, 120) : humanizeSlug(slug);

  const description = fields.description
    ? stripQuotes(fields.description).slice(0, 2000)
    : null;
  if (!description) {
    return {
      ok: false,
      error: "Frontmatter is missing the required `description`.",
    };
  }

  const systemPrompt = (body ?? "").trim();
  if (!systemPrompt) {
    return {
      ok: false,
      error: "The skill body (instructions below the frontmatter) is empty.",
    };
  }

  let modelId = DEFAULT_MODEL_ID;
  if (fields.model) {
    const candidate = stripQuotes(fields.model).toLowerCase();
    if (isValidModelId(candidate)) modelId = candidate;
    else warnings.push(`Unknown model "${candidate}"; using ${DEFAULT_MODEL_ID}.`);
  }

  let mcpProviders: string[] = [];
  if (fields.mcp_providers) {
    const requested = parseList(fields.mcp_providers).map((p) => p.toLowerCase());
    mcpProviders = requested.filter((p) =>
      SUPPORTED_MCP_PROVIDERS.includes(p),
    );
    const unsupported = requested.filter(
      (p) => !SUPPORTED_MCP_PROVIDERS.includes(p),
    );
    if (unsupported.length > 0) {
      warnings.push(`Dropped unsupported provider(s): ${unsupported.join(", ")}.`);
    }
  }
  if (fields.web_access?.trim().toLowerCase() === "true") {
    mcpProviders = [...new Set([...mcpProviders, SKILL_WEB_ACCESS_DECLARATION])];
  }

  const known = new Set([
    "name",
    "description",
    "model",
    "mcp_providers",
    "web_access",
  ]);
  for (const key of Object.keys(fields)) {
    if (!known.has(key)) warnings.push(`Ignored unknown frontmatter key "${key}".`);
  }

  return {
    ok: true,
    skill: { name, slug, description, systemPrompt, modelId, mcpProviders, warnings },
  };
}

/** Render a skill row back to a portable SKILL.md document. */
export function serializeSkillToMarkdown(skill: {
  slug: string;
  description: string | null;
  systemPrompt: string;
  modelId: string;
  mcpProviders: string[];
}): string {
  const lines = ["---", `name: ${skill.slug}`];
  if (skill.description) lines.push(`description: ${skill.description}`);
  lines.push(`model: ${skill.modelId}`);
  if (skill.mcpProviders.length > 0) {
    const providers = skillMcpProviders(skill.mcpProviders);
    if (providers.length > 0) {
      lines.push(`mcp_providers: [${providers.join(", ")}]`);
    }
  }
  if (skillDeclaresWebAccess(skill.mcpProviders)) {
    lines.push("web_access: true");
  }
  lines.push("---", "", skill.systemPrompt, "");
  return lines.join("\n");
}
