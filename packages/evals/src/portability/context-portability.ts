/**
 * Context-portability checker (issue #304).
 *
 * Deterministic deny-list over durable prompt objects — skills, starter
 * skills, agent-preamble output, context-pack templates. Durable text must
 * stay provider-neutral so a model swap is a config change, not a rewrite.
 *
 * What is banned here is *vendor identity in durable text* (naming the
 * provider or model family the assistant "is"). What stays allowed:
 * - the runtime injecting the ACTUAL current model identity at turn time
 *   (identity honesty — checked by building the preamble with a neutral
 *   test model id, where no vendor branding may survive);
 * - registry model ids (`sonnet-4-5`, `haiku-4-5`) as config vocabulary,
 *   e.g. a skill's `model:` field or the Skill Creator's guidance — those
 *   are product registry keys, not vendor claims.
 *
 * Contract documented in docs/REGRESSION_GAUNTLET.md ("Context portability").
 */

export interface DurableContextObject {
  /** e.g. "starter-skill", "skill-row", "agent-preamble", "context-template" */
  kind: string;
  /** How a human finds the offending object: slug, function name, fixture id. */
  id: string;
  text: string;
}

export interface PortabilityViolation {
  kind: string;
  id: string;
  /** The deny-list rule that matched. */
  reason: string;
  /** The matched text with surrounding context. */
  excerpt: string;
}

const EXCERPT_RADIUS = 40;

const DENY_LIST: ReadonlyArray<{ re: RegExp; reason: string }> = [
  {
    re: /\bclaude\b/i,
    reason:
      'Anthropic model-family reference ("Claude") in durable text — the runtime injects the real model identity at turn time',
  },
  {
    re: /\banthropic\b/i,
    reason: "provider name in durable text",
  },
  {
    re: /\bopenai\b|\bchatgpt\b|\bgpt-[0-9]/i,
    reason: "competitor provider/model reference in durable text",
  },
  {
    re: /\bgemini\b|\bbard\b/i,
    reason: "competitor provider/model reference in durable text",
  },
  {
    re: /<thinking>/i,
    reason:
      "Anthropic-specific <thinking> tag convention — use neutral phrasing",
  },
];

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(text.length, index + length + EXCERPT_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ")}${suffix}`;
}

/**
 * Scan durable objects against the deny-list. Empty result = portable.
 * Each violation points at the offending object and shows the match in
 * context so the failure is actionable without re-running anything.
 */
export function checkContextPortability(
  objects: readonly DurableContextObject[],
): PortabilityViolation[] {
  const violations: PortabilityViolation[] = [];
  for (const object of objects) {
    for (const { re, reason } of DENY_LIST) {
      const match = re.exec(object.text);
      if (match) {
        violations.push({
          kind: object.kind,
          id: object.id,
          reason,
          excerpt: excerptAround(object.text, match.index, match[0].length),
        });
      }
    }
  }
  return violations;
}

/** One line per violation — readable straight from a failed CI assertion. */
export function formatPortabilityViolations(
  violations: readonly PortabilityViolation[],
): string {
  return violations
    .map((v) => `[${v.kind}:${v.id}] ${v.reason} — "${v.excerpt}"`)
    .join("\n");
}
