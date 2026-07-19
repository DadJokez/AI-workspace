/**
 * Skill namespacing rails (#412, day-one items from
 * docs/specs/skills-extensibility-architecture.md).
 *
 * The threat this closes is mundane and dominant: 54.1% of confirmed-
 * malicious skills in the wild are templated brand impersonations, and
 * Comparative's global slug space plus silent suffix-on-collision
 * (insertSkillWithUniqueSlug) means "Weekly Status" today mints
 * `weekly-status-abc123` — indistinguishable from the starter in the
 * picker. These checks are deterministic shell code at create/update and
 * a reservation re-check at activation; no schema change.
 *
 * Full `owner/skill-name` namespaced slugs are deliberately NOT here —
 * they change the slash-token UX and belong with the catalog tiers
 * (needs the product call + migration tracked in #412's larger scope).
 */

export const RESERVED_SKILL_PREFIXES = [
  "comparative",
  "starter",
  "system",
  "admin",
  "official",
] as const;

/**
 * Collision key: lowercase, diacritics stripped, non-alphanumerics
 * removed. "Wéekly-Statüs", "Weekly Status", and "weekly_status" all map
 * to "weeklystatus".
 */
export function normalizeSkillNameKey(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Keys a candidate could be confused with: the plain key plus the key
 * with trailing digits/suffix noise stripped, so "Weekly Status 2" and
 * the collision-suffix shape "weekly-status-a1b2c3" both collide with
 * "weekly-status".
 */
function confusableKeys(value: string): string[] {
  const key = normalizeSkillNameKey(value);
  const keys = new Set([key]);
  const withoutTrailingDigits = key.replace(/\d+$/, "");
  if (withoutTrailingDigits.length >= 4) keys.add(withoutTrailingDigits);
  // The random collision suffix insertSkillWithUniqueSlug appends is 6
  // alphanumerics; strip one dash-delimited trailing token from the RAW
  // value before normalizing to catch it.
  const rawStripped = value.trim().replace(/[-_ ][a-z0-9]{1,8}$/i, "");
  const strippedKey = normalizeSkillNameKey(rawStripped);
  if (strippedKey.length >= 4) keys.add(strippedKey);
  return [...keys];
}

/** True when a slug's first token is a reserved platform prefix. */
export function isReservedSkillSlug(slug: string): boolean {
  const firstToken = normalizeSkillNameKey(slug.split(/[-_/]/)[0] ?? "");
  return RESERVED_SKILL_PREFIXES.some((prefix) => firstToken === prefix);
}

export interface ExistingSkillNameRow {
  slug: string;
  name: string;
  isStarter: boolean;
  ownerUserId: string | null;
}

export type SkillNamingConflict =
  | { reason: "reserved_prefix"; token: string }
  | { reason: "impersonates_starter"; conflictingSlug: string }
  | { reason: "impersonates_existing"; conflictingSlug: string };

/**
 * Deterministic pre-insert/pre-update check. Admins are exempt (they own
 * the starter catalog); renaming/updating your own skill never conflicts
 * with itself.
 */
export function findSkillNamingConflict({
  name,
  slug,
  existing,
  actorUserId,
  actorIsAdmin = false,
  selfSlug,
}: {
  name: string;
  slug?: string | null;
  existing: readonly ExistingSkillNameRow[];
  actorUserId: string;
  actorIsAdmin?: boolean;
  /** When updating, the skill's own slug (self-matches are allowed). */
  selfSlug?: string | null;
}): SkillNamingConflict | null {
  if (actorIsAdmin) return null;

  const candidates = [name, ...(slug ? [slug] : [])];
  for (const value of candidates) {
    const firstToken = normalizeSkillNameKey(
      value.trim().split(/[\s\-_/]+/)[0] ?? "",
    );
    const reserved = RESERVED_SKILL_PREFIXES.find(
      (prefix) => firstToken === prefix,
    );
    if (reserved) return { reason: "reserved_prefix", token: reserved };
  }

  const candidateKeys = new Set(candidates.flatMap(confusableKeys));
  for (const row of existing) {
    if (selfSlug && row.slug === selfSlug) continue;
    if (row.ownerUserId === actorUserId && !row.isStarter) continue;
    const rowKeys = new Set([
      normalizeSkillNameKey(row.name),
      normalizeSkillNameKey(row.slug),
    ]);
    const collides = [...candidateKeys].some((key) => rowKeys.has(key));
    if (!collides) continue;
    return row.isStarter
      ? { reason: "impersonates_starter", conflictingSlug: row.slug }
      : { reason: "impersonates_existing", conflictingSlug: row.slug };
  }
  return null;
}

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all |any )?(previous|prior|earlier) (instructions|rules|context)/i,
  /disregard (the |your )?(system|previous|prior)/i,
  /you are now/i,
  /<<<|>>>/,
];

const FALSE_AUTHORITY_PATTERNS: readonly RegExp[] = [
  /\bofficial\b/i,
  /\bverified\b/i,
  /\bendorsed\b/i,
];

export type SkillDescriptionLint =
  | { ok: true }
  | {
      ok: false;
      reason: "too_short" | "too_long" | "instruction_like" | "false_authority";
      message: string;
    };

/**
 * Description lint (#412): the description is catalog metadata rendered to
 * other users and, eventually, to auto-selection — it must describe, not
 * instruct, and must not claim authority the catalog doesn't grant.
 * Deterministic only; the should/should-not-trigger eval probes from the
 * spec are follow-up work once auto-selection exists.
 */
export function lintSkillDescription(
  description: string,
): SkillDescriptionLint {
  const trimmed = description.trim();
  if (trimmed.length < 10) {
    return {
      ok: false,
      reason: "too_short",
      message:
        "Describe what the skill does in at least 10 characters so others can evaluate it.",
    };
  }
  if (trimmed.length > 300) {
    return {
      ok: false,
      reason: "too_long",
      message: "Keep the description under 300 characters.",
    };
  }
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return {
      ok: false,
      reason: "instruction_like",
      message:
        "The description should describe the skill, not carry instructions to the assistant.",
    };
  }
  if (FALSE_AUTHORITY_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return {
      ok: false,
      reason: "false_authority",
      message:
        'Descriptions cannot claim "official"/"verified" status — the catalog itself is the authority signal.',
    };
  }
  return { ok: true };
}
