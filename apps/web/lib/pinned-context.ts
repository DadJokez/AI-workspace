import { createHash } from "node:crypto";
import type { PinnedActiveSkill } from "@ai-workspace/agent";

/**
 * Pinned constraint layer (#416): governing context must live in the stable
 * system prefix — never only inside a summarizable region — and re-inject
 * from its authoritative source on every request. Everything here is
 * DETERMINISTIC: no timestamps, nonces, or turn-local values. Identical
 * source state must produce byte-identical output (the #385 cache
 * discipline is what makes the pin real).
 *
 * The layer contract itself — precedence note, skill/org renderers, and the
 * instruction-layers receipt — lives in
 * `packages/agent/src/instruction-layers.ts` (#438 P0) so the web shell and
 * the evals render the same text. This module keeps the web-only piece: the
 * hash receipt over the assembled prefix.
 */
export {
  PINNED_PRECEDENCE_NOTE,
  renderPinnedActiveSkill,
  renderPinnedOrgInstructions,
} from "@ai-workspace/agent";
export type { PinnedActiveSkill, PinnedOrgInstructions } from "@ai-workspace/agent";

export interface PinnedContextReceipt {
  schemaVersion: 1;
  /** sha256 of the full stable system prefix — rotates only on real source changes. */
  hash: string;
  chars: number;
  activeSkill?: { id: string; slug: string; chars: number };
}

/**
 * Receipt over the assembled stable prefix. The hash is the observable
 * pin: ordinary turns, summary updates, receipts, and recommendations must
 * leave it byte-identical; an approved-memory edit, custom-instruction
 * edit, governance update, org-document approval, or skill (de)activation
 * rotates it exactly once. Rendered only in the volatile suffix / Run
 * Inspector — never inside the pinned block itself.
 */
export function buildPinnedContextReceipt(
  stableSystemPrompt: string,
  activeSkill?: PinnedActiveSkill | null,
): PinnedContextReceipt {
  return {
    schemaVersion: 1,
    hash: createHash("sha256").update(stableSystemPrompt, "utf8").digest("hex"),
    chars: stableSystemPrompt.length,
    ...(activeSkill
      ? {
          activeSkill: {
            id: activeSkill.id,
            slug: activeSkill.slug,
            chars: activeSkill.systemPrompt.length,
          },
        }
      : {}),
  };
}
