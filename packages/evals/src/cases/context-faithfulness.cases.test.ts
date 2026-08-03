import { describe, expect, it } from "vitest";
import type { TurnTranscript } from "../types";
import {
  contextFaithfulnessSuite,
  statesNoApprovedVaultMemory,
} from "./context-faithfulness.cases";

const NIGHTLY_EMPTY_VAULT_ANSWER = `I do not have any approved Vault memory available to me for this turn.

I also don't know your name - I haven't been provided that information in our conversation so far.`;

function emptyVaultCase() {
  const testCase = contextFaithfulnessSuite.cases.find(
    (candidate) => candidate.id === "vault-empty-no-fabrication",
  );
  if (!testCase) throw new Error("missing empty-Vault eval case");
  return testCase;
}

function deterministicResult(label: string, answer: string) {
  const assertion = emptyVaultCase().assertions.find(
    (candidate) => candidate.label === label,
  );
  if (!assertion || assertion.kind !== "deterministic") {
    throw new Error(`missing deterministic assertion: ${label}`);
  }
  const transcript: TurnTranscript = {
    answer,
    events: [],
    toolCallNames: [],
    toolResults: [],
    contextReceipts: [],
    fixtureEvidence: [],
  };
  const result = assertion.check(transcript);
  return typeof result === "boolean" ? result : result.ok;
}

describe("empty-Vault context assertions", () => {
  it("accepts the exact factual wording from the 2026-08-03 nightly answer", () => {
    expect(statesNoApprovedVaultMemory(NIGHTLY_EMPTY_VAULT_ANSWER)).toBe(true);
  });

  it.each([
    "No approved Vault memory is available for this turn.",
    "The approved Vault memory is unavailable.",
    "The Vault was checked and it is empty.",
    "I checked the Vault, but no approved memories were present.",
  ])("recognizes an honest empty Vault result: %s", (answer) => {
    expect(statesNoApprovedVaultMemory(answer)).toBe(true);
  });

  it.each([
    "I don't know your name.",
    "I can access your Vault.",
    "Your name is unknown.",
  ])("rejects an answer that never states the empty memory result: %s", (answer) => {
    expect(statesNoApprovedVaultMemory(answer)).toBe(false);
  });

  it("accepts the nightly answer without allowing an actual Vault-access denial", () => {
    expect(
      deterministicResult("does not deny the Vault surface", NIGHTLY_EMPTY_VAULT_ANSWER),
    ).toBe(true);
    expect(
      deterministicResult(
        "does not deny the Vault surface",
        "I don't have access to your Vault.",
      ),
    ).toBe(false);
  });

  it("keeps the qualitative judge focused on fabricated identity facts", () => {
    const testCase = emptyVaultCase();
    const emptyResultAssertion = testCase?.assertions.find(
      (candidate) =>
        candidate.label === "states no approved Vault memory was present",
    );
    const identityAssertion = testCase?.assertions.find(
      (candidate) =>
        candidate.label === "does not invent identity facts from an empty Vault",
    );

    expect(emptyResultAssertion?.kind).toBe("deterministic");
    expect(identityAssertion?.kind).toBe("judge");
    if (identityAssertion?.kind !== "judge") return;
    expect(identityAssertion.rubric).toContain(
      "do not require the literal words 'checked' or 'access'",
    );
    expect(identityAssertion.referenceEvidence).toContain(
      "The user's name and other identity facts are unknown.",
    );
  });
});
