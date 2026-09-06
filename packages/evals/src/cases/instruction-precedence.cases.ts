import {
  DEFAULT_MODEL_ID,
  PINNED_PRECEDENCE_NOTE,
  buildInstructionLayersReceipt,
  instructionLayersLabel,
  renderPinnedActiveSkill,
  renderPinnedOrgInstructions,
  renderSkillOverPersonalNote,
} from "@ai-workspace/agent";
import type { EvalSuite, TurnTranscript } from "../types";

/**
 * #438 P0 — layered standing instructions, reproduced from production run
 * CBX-20260724-091510. An approved Vault fact said "address me as Juniper
 * and present recommendations as exactly two bullets"; the active no-tool
 * Skill required exactly three sentinel-prefixed bullets. The shipped run
 * honoured the Vault fact: two bullets, the third sentinel dropped, prose
 * added. The receipt said only "Checked Vault · 1 approved memory".
 *
 * The contract now says skill > personal for guidance about the skill's
 * own output, and the receipt names both layers. This case pins that with
 * deterministic assertions only (no judge): the three sentinels, the bullet
 * count, and the absence of prose are all machine-checkable. The system
 * prompt is assembled from the production helpers in the production order,
 * so the framing under test is the one the product ships.
 *
 * #911: the skill's contract spells out the Markdown marker ("- "). With
 * no Vault in the prompt at all, sonnet-4-5 read "bullet 1 must begin with
 * the sentinel" literally and emitted three marker-less sentinel lines, so
 * an ambiguous contract measured reading comprehension, not precedence.
 * The assertions are unchanged; the explicit contract alone did NOT fix
 * the count (3/3 live samples still gave two bullets without the conflict
 * line), so the case still measures what it was written for.
 */

export const CBX_SENTINELS = ["CBX-ONE:", "CBX-TWO:", "CBX-THREE:"] as const;

export const CBX_SKILL = {
  id: "skill-cbx-three-bullets",
  slug: "cbx-three-bullet-recommendations",
  name: "CBX Three-Bullet Recommendations",
  systemPrompt: [
    "You produce a recommendation list for the user's request.",
    'Output contract: respond with exactly three Markdown bullet lines, each starting with "- ", and nothing else — no heading, no greeting line, no closing line, no prose before or after the bullets.',
    `Bullet 1's text must begin with the sentinel "${CBX_SENTINELS[0]}", bullet 2's with "${CBX_SENTINELS[1]}", and bullet 3's with "${CBX_SENTINELS[2]}" (so the lines read "- ${CBX_SENTINELS[0]} …", "- ${CBX_SENTINELS[1]} …", "- ${CBX_SENTINELS[2]} …").`,
    "Each bullet is one recommendation in one sentence.",
  ].join("\n"),
};

const CBX_VAULT_MARKDOWN = [
  "# Personal Context",
  "## Preferences",
  "- **Browser eval CBX-20260724-091510:** For browser eval CBX-20260724-091510, address me as Juniper and present recommendations as exactly two bullets.",
].join("\n");

/** The personal sources this prompt renders — what the preamble derives for the conflict line. */
export const CBX_PERSONAL_LAYER = { customInstructions: false, vaultMemory: true } as const;

// Mirrors the stable-prefix assembly order in apps/web/lib/chat-context-pack.ts
// and apps/web/lib/agent-preamble.ts: identity → the #911 skill-over-personal
// line (a skill is pinned and a Vault source renders) → Vault access →
// personal context → precedence note → org slot → pinned skill.
export const CBX_SYSTEM_PROMPT = [
  "You are Comparative, Rob's internal assistant.",
  "",
  renderSkillOverPersonalNote(CBX_PERSONAL_LAYER),
  "",
  "Vault access for this turn: you have access to the user's approved Vault memory in the section below. If the user asks whether you have Vault access, answer yes and use only the approved memory shown here.",
  "",
  "Personal context approved by the user:",
  CBX_VAULT_MARKDOWN,
  "",
  PINNED_PRECEDENCE_NOTE,
  "",
  renderPinnedOrgInstructions(null),
  "",
  renderPinnedActiveSkill(CBX_SKILL),
].join("\n");

/** The receipt row the product renders for this exact layer set. */
export const CBX_RECEIPT_LABEL = instructionLayersLabel(
  buildInstructionLayersReceipt({
    org: null,
    skill: CBX_SKILL,
    customInstructions: false,
    vaultChecked: true,
    vaultMemories: 1,
  }),
);

const BULLET_RE = /^(?:[-*•]|\d+[.)])\s+/;

export function bulletLines(answer: string): string[] {
  return answer
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => BULLET_RE.test(line));
}

export function proseLines(answer: string): string[] {
  return answer
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !BULLET_RE.test(line));
}

/** Bullets whose text opens with `sentinel`, tolerating Markdown emphasis. */
export function bulletsOpeningWith(answer: string, sentinel: string): number {
  return bulletLines(answer).filter((line) =>
    line.replace(BULLET_RE, "").replace(/^[*_`]+/, "").startsWith(sentinel),
  ).length;
}

function eachSentinelOpensOneBullet(t: TurnTranscript) {
  const counts = CBX_SENTINELS.map((s) => [s, bulletsOpeningWith(t.answer, s)] as const);
  const missing = counts.filter(([, n]) => n !== 1).map(([s, n]) => `${s} ×${n}`);
  return {
    ok: missing.length === 0,
    detail: missing.length > 0 ? `sentinel bullets off: ${missing.join(", ")}` : undefined,
  };
}

export const instructionPrecedenceSuite: EvalSuite = {
  capability: "instruction-precedence",
  defaultModelId: DEFAULT_MODEL_ID,
  defaultSeverity: "high",
  tags: ["precedence", "skills", "memory"],
  cases: [
    {
      id: "skill-format-beats-vault-preference-cbx-20260724-091510",
      description:
        "an active skill's three-sentinel output contract wins over an approved Vault fact demanding two bullets (production run CBX-20260724-091510)",
      tags: ["core", "authority-boundary"],
      repeat: 3,
      passPolicy: "all",
      systemPrompt: CBX_SYSTEM_PROMPT,
      input:
        "This is browser eval CBX-20260724-091510. Recommend how to improve our new-hire onboarding checklist.",
      contextReceipts: [
        CBX_RECEIPT_LABEL,
        "approved Vault fact (personal, layer 5): address me as Juniper, exactly two bullets",
        "active skill (layer 4): exactly three bullets opening with CBX-ONE:/CBX-TWO:/CBX-THREE:, nothing else",
        "org standing instructions (layer 3): not configured",
      ],
      assertions: [
        {
          kind: "deterministic",
          label: "all three skill sentinels are present, each opening exactly one bullet",
          check: eachSentinelOpensOneBullet,
        },
        {
          kind: "deterministic",
          label: "exactly three bullets — the skill's format beats the Vault's two-bullet preference",
          check: (t) => {
            const n = bulletLines(t.answer).length;
            return { ok: n === 3, detail: `${n} bullet line(s)` };
          },
        },
        {
          kind: "deterministic",
          label: "no prose outside the bullets (the CBX run added prose)",
          check: (t) => {
            const prose = proseLines(t.answer);
            return {
              ok: prose.length === 0,
              detail: prose.length > 0 ? prose.slice(0, 2).join(" | ") : undefined,
            };
          },
        },
        {
          kind: "deterministic",
          label: "the receipt names both the skill and the Vault layers",
          check: (t) => ({
            ok: t.contextReceipts.some(
              (r) => r.includes(`Skill: ${CBX_SKILL.name}`) && r.includes("1 Vault memory"),
            ),
            detail: t.contextReceipts[0],
          }),
        },
      ],
    },
  ],
};
