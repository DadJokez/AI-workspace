/**
 * Slash-command matching for the chat input (#144): typing "/" opens a
 * palette of the user's runnable skills; the query matches forgivingly so
 * first-contact attempts like "/skills developer briefing" or
 * "/run weekly status" resolve to the right skill.
 */
export interface SlashSkillCandidate {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  mcpProviders: string[];
}

export interface ActivatedSlashSkill {
  id: string;
  slug: string;
  name: string;
  args: string;
  source: "explicit";
}

export interface ParsedSlashDisplayMessage {
  token: string;
  body: string;
}

/** Leading tokens users naturally type that aren't part of the skill name. */
const NOISE_TOKENS = new Set(["skills", "skill", "run", "use"]);

/**
 * Words that describe the kind of output more than the skill itself. Keep
 * them when they are the whole query ("/brief" should still find briefs),
 * but drop them from multi-word queries like "/weekly brief" so the
 * distinctive token can match the intended skill.
 */
const GENERIC_INTENT_TOKENS = new Set([
  "brief",
  "briefing",
  "draft",
  "report",
  "recap",
  "summarize",
  "summary",
  "update",
]);

export function isSlashCommand(input: string): boolean {
  return input.trimStart().startsWith("/");
}

export function slashSkillToken(skill: Pick<SlashSkillCandidate, "slug">): string {
  return `/${skill.slug}`;
}

export function buildSlashSkillDisplayMessage(
  skill: Pick<SlashSkillCandidate, "slug">,
  args = "",
): string {
  const body = args.trim();
  return body ? `${slashSkillToken(skill)} ${body}` : slashSkillToken(skill);
}

export function parseSlashDisplayMessage(
  input: string,
): ParsedSlashDisplayMessage | null {
  const match = /^\/([a-z0-9][a-z0-9-]{0,79})(?:\s+([\s\S]*))?$/i.exec(
    input.trimStart(),
  );
  if (!match) return null;
  return {
    token: `/${match[1]}`,
    body: (match[2] ?? "").trimStart(),
  };
}

/** Strip the slash and noise tokens: "/skills developer briefing" → "developer briefing". */
export function slashQuery(input: string): string {
  const raw = input.trimStart().replace(/^\/+/, "").trim();
  const words = raw.split(/\s+/).filter(Boolean);
  while (words.length > 0 && NOISE_TOKENS.has(words[0]!.toLowerCase())) {
    words.shift();
  }
  return words.join(" ");
}

/**
 * Filter skills against a slash query. Every query word must appear in the
 * skill's name, slug, or description (case-insensitive substring). An empty
 * query matches everything. Results keep name-match-first ordering so the
 * highlighted default is the intuitive one.
 */
export function filterSkillsForCommand<T extends SlashSkillCandidate>(
  input: string,
  skills: readonly T[],
): T[] {
  const query = slashQuery(input).toLowerCase();
  if (!query) return [...skills];
  const rawWords = query.split(/\s+/).filter(Boolean);
  const specificWords = rawWords.filter((w) => !GENERIC_INTENT_TOKENS.has(w));
  const words = specificWords.length > 0 ? specificWords : rawWords;

  const scored = skills
    .map((skill) => {
      const name = skill.name.toLowerCase();
      const haystack = `${name} ${skill.slug.toLowerCase()} ${(skill.description ?? "").toLowerCase()}`;
      if (!words.every((w) => haystack.includes(w))) return null;
      const nameHit = words.every((w) => name.includes(w));
      const prefixHit = name.startsWith(words[0]!);
      return { skill, score: (nameHit ? 2 : 0) + (prefixHit ? 1 : 0) };
    })
    .filter((entry): entry is { skill: T; score: number } => entry !== null);

  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.skill);
}

export function resolveSlashSkillActivation<T extends SlashSkillCandidate>(
  input: string,
  skills: readonly T[],
): { skill: T; args: string } | null {
  if (!isSlashCommand(input)) return null;

  const exact = resolveExactSlashSkillActivation(input, skills);
  if (exact) return exact;

  const query = slashQuery(input);
  if (!query) return null;

  return resolveFuzzySlashSkillActivation(input, skills);
}

export function buildActivatedSlashSkill(
  skill: Pick<SlashSkillCandidate, "id" | "slug" | "name">,
  args = "",
): ActivatedSlashSkill {
  return {
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    args: args.trim(),
    source: "explicit",
  };
}

export function slashArgumentsForSkill<T extends SlashSkillCandidate>(
  input: string,
  skill: T,
): string {
  return (
    resolveExactSlashSkillActivation(input, [skill])?.args ??
    resolveFuzzySlashSkillActivation(input, [skill])?.args ??
    ""
  );
}

function resolveExactSlashSkillActivation<T extends SlashSkillCandidate>(
  input: string,
  skills: readonly T[],
): { skill: T; args: string } | null {
  const raw = input.trimStart().replace(/^\/+/, "");
  if (!raw.trim()) return null;
  const lowerRaw = raw.toLowerCase();

  const candidates = skills.flatMap((skill) =>
    commandAliasesForSkill(skill).map((alias) => ({ skill, alias })),
  );
  candidates.sort((a, b) => b.alias.length - a.alias.length);

  for (const candidate of candidates) {
    const alias = candidate.alias.toLowerCase();
    if (lowerRaw === alias) {
      return { skill: candidate.skill, args: "" };
    }
    if (lowerRaw.startsWith(`${alias} `)) {
      return {
        skill: candidate.skill,
        args: raw.slice(candidate.alias.length).trimStart(),
      };
    }
  }
  return null;
}

function resolveFuzzySlashSkillActivation<T extends SlashSkillCandidate>(
  input: string,
  skills: readonly T[],
): { skill: T; args: string } | null {
  const words = slashQuery(input).split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  for (let prefixLength = words.length; prefixLength >= 1; prefixLength--) {
    const prefix = words.slice(0, prefixLength).join(" ");
    const matches = filterSkillsForCommand(`/${prefix}`, skills);
    if (matches.length === 1) {
      return {
        skill: matches[0]!,
        args: words.slice(prefixLength).join(" "),
      };
    }
  }
  return null;
}

function commandAliasesForSkill(skill: SlashSkillCandidate): string[] {
  const aliases = [
    skill.slug,
    skill.name.toLowerCase().replace(/\s+/g, "-"),
    skill.name.toLowerCase().replace(/\s+/g, " "),
  ];
  return Array.from(new Set(aliases.map((alias) => alias.trim()).filter(Boolean)));
}
