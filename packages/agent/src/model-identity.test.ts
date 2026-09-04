import { describe, expect, it } from "vitest";
import { modelIdentityLine } from "./model-identity";
import { DEFAULT_MODEL_ID, MODEL_IDS, MODELS } from "./models";

/**
 * The honesty spine's identity half (rubric priority 3), pinned on the one
 * production template (#856): the assistant must never claim a wrong model or
 * a vendor the turn may not be running on (#304). Every expectation derives
 * from the registry's identity fields — the tests pin that the helper uses
 * them, not any particular vendor (#797 P1).
 */
describe("modelIdentityLine", () => {
  it.each(MODEL_IDS)(
    "%s: states the real branded model and forbids claiming an older one",
    (modelId) => {
      const line = modelIdentityLine(modelId);
      const { brandedName, providerDisplayName, olderModelExample } =
        MODELS[modelId];
      expect(line).toContain(
        `You are powered by ${brandedName}, made by ${providerDisplayName}.`,
      );
      // `olderModelExample` is optional: a family with no known misclaim
      // omits it and gets the neutral wording — no test edit required.
      expect(line).toContain(
        olderModelExample
          ? `answer "${brandedName}" — never claim to be a different vendor's model or an older model such as "${olderModelExample}".`
          : `answer "${brandedName}" — never claim to be a different vendor's model or an older model version.`,
      );
      // And never any OTHER registry model's name.
      for (const otherId of MODEL_IDS) {
        if (otherId === modelId) continue;
        expect(line).not.toContain(MODELS[otherId].displayName);
      }
    },
  );

  it("renders the default model's sentence byte-identical to the pre-#856 template", () => {
    // Frozen copy of what loop.ts and buildAgentPreamble each rendered for
    // the default model before the dedupe: single-sourcing must be a pure
    // refactor for current Claude models. If DEFAULT_MODEL_ID moves, update
    // this literal deliberately — that is a product change, not drift.
    expect(DEFAULT_MODEL_ID).toBe("sonnet-4-5");
    expect(modelIdentityLine(DEFAULT_MODEL_ID)).toBe(
      'You are powered by Claude Sonnet 4.5, made by Anthropic. If asked which model or version you are, answer "Claude Sonnet 4.5" — never claim to be a different vendor\'s model or an older model such as "Claude 3.5".',
    );
  });

  it("falls back to neutral older-model wording when the registry entry has no olderModelExample", () => {
    // The forward-portability branch: a non-Claude family may have no
    // training-prior misclaim to name. Stand in for such an entry by
    // temporarily stripping the field from a real one.
    const entry = MODELS["sonnet-4-6"];
    const saved = entry.olderModelExample;
    delete entry.olderModelExample;
    try {
      const line = modelIdentityLine("sonnet-4-6");
      expect(line).toContain(
        `answer "${entry.brandedName}" — never claim to be a different vendor's model or an older model version.`,
      );
      expect(line).not.toContain("older model such as");
    } finally {
      entry.olderModelExample = saved;
    }
  });

  it("gives an unknown model id a neutral identity with no hardcoded vendor (#304)", () => {
    const line = modelIdentityLine("candidate-model-x");
    expect(line).toBe(
      'You are powered by the model registered as "candidate-model-x". If asked which model or version you are, answer "candidate-model-x" — never claim to be a different model or vendor.',
    );
    // Durable text must not claim Anthropic/Claude for a turn that may not
    // be running on either.
    expect(line).not.toContain("Anthropic");
    expect(line).not.toContain("Claude");
  });

  it("never resolves an id through the registry object's prototype", () => {
    // Not registry entries, but a plain index lookup would find them on
    // Object.prototype and render "powered by undefined".
    for (const id of ["constructor", "toString", "__proto__"]) {
      expect(modelIdentityLine(id)).toContain(
        `the model registered as "${id}"`,
      );
    }
  });
});
