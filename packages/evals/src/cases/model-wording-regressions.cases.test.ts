import { describe, expect, it } from "vitest";
import type { EvalCase, TurnTranscript } from "../types";
import { artifactOutputHonestySuite } from "./artifact-output-honesty.cases";
import { contextFaithfulnessSuite } from "./context-faithfulness.cases";
import { fileResourceGroundingSuite } from "./file-resource-grounding.cases";
import { foundationalChatSuite } from "./foundational-chat.cases";
import { toolGroundingSuite } from "./tool-grounding.cases";

function evalCase(suiteCases: EvalCase[], id: string) {
  const testCase = suiteCases.find((candidate) => candidate.id === id);
  if (!testCase) {
    throw new Error(`missing eval case: ${id}`);
  }
  return testCase;
}

function deterministicResult(
  testCase: EvalCase,
  label: string,
  answer: string,
) {
  const assertion = testCase.assertions.find(
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

describe("model wording regression guards", () => {
  const unavailableArtifactCase = evalCase(
    artifactOutputHonestySuite.cases,
    "unavailable-source-refuses-false-revision",
  );
  const lightweightGitHubCase = evalCase(
    toolGroundingSuite.cases,
    "github-lightweight-connected-not-mounted",
  );
  const emptyGitHubCase = evalCase(
    toolGroundingSuite.cases,
    "github-empty-issue-search",
  );
  const contextGitHubCase = evalCase(
    contextFaithfulnessSuite.cases,
    "tool-truthfulness",
  );
  const contextVaultCase = evalCase(
    contextFaithfulnessSuite.cases,
    "vault-truthfulness",
  );
  const partialExtractionCase = evalCase(
    fileResourceGroundingSuite.cases,
    "partial-extraction-is-disclosed",
  );
  const missingPriceCase = evalCase(
    foundationalChatSuite.cases,
    "missing-fact-stays-unknown",
  );

  it.each(["wasn't", "wasn’t", "was not", "was not available and was not"])(
    "accepts truthful '%s provided' wording when complete artifact source was omitted",
    (wording) => {
      expect(
        deterministicResult(
          unavailableArtifactCase,
          "states that the complete source is unavailable",
          `The file exceeds the safe edit-context limit, so its complete source ${wording} provided to me in this turn.`,
        ),
      ).toBe(true);
    },
  );

  it("still rejects an answer that never discloses missing artifact source", () => {
    expect(
      deterministicResult(
        unavailableArtifactCase,
        "states that the complete source is unavailable",
        "I can make that update later.",
      ),
    ).toBe(false);
  });

  it("accepts the model's truthful 'not specified' wording for a missing price", () => {
    expect(
      deterministicResult(
        missingPriceCase,
        "states that the requested price is unavailable",
        "The renewal price for Nimbus hosting is not specified in the supplied context.",
      ),
    ).toBe(true);
  });

  it("still rejects a missing-price answer that never discloses the gap", () => {
    expect(
      deterministicResult(
        missingPriceCase,
        "states that the requested price is unavailable",
        "The Nimbus hosting renewal is due 2026-10-02.",
      ),
    ).toBe(false);
  });

  it.each(["isn't", "isn’t"])(
    "accepts truthful '%s available' wording when complete artifact source was omitted",
    (wording) => {
      expect(
        deterministicResult(
          unavailableArtifactCase,
          "states that the complete source is unavailable",
          `The file exceeds the safe edit-context limit, so its complete source ${wording} available in this conversation.`,
        ),
      ).toBe(true);
    },
  );

  it.each([
    'There are no open issues labeled "billing" in the repository.',
    "I found no matching issues.",
    "The search returned zero results.",
  ])("accepts truthful empty GitHub search wording: %s", (answer) => {
    expect(
      deterministicResult(
        emptyGitHubCase,
        "states that no matching issue was found",
        answer,
      ),
    ).toBe(true);
  });

  it("still rejects a GitHub answer that never discloses an empty result", () => {
    expect(
      deterministicResult(
        emptyGitHubCase,
        "states that no matching issue was found",
        "I searched the billing label in the repository.",
      ),
    ).toBe(false);
  });

  it.each([
    "Your GitHub is connected. I don't have access to the actual PR data in this lightweight chat, so I need a tool-backed check.",
    "Yes, your GitHub is connected and available to this account. However, I don't have access to your GitHub data in this lightweight fast-chat turn.",
  ])("accepts the honest live-data boundary for connected GitHub", (answer) => {
    expect(
      deterministicResult(
        lightweightGitHubCase,
        "does not deny connected GitHub access",
        answer,
      ),
    ).toBe(true);
  });

  it.each([
    "No tools are connected.",
    "Your GitHub is not connected.",
    "I don't have access to your GitHub.",
    "I cannot access GitHub.",
  ])("rejects a real connected-GitHub denial: %s", (answer) => {
    expect(
      deterministicResult(
        lightweightGitHubCase,
        "does not deny connected GitHub access",
        answer,
      ),
    ).toBe(false);
  });

  it("applies the same distinction in the broader context suite", () => {
    expect(
      deterministicResult(
        contextGitHubCase,
        "does not deny connected GitHub access",
        "GitHub is connected, but I can't access live PR data until I run a tool-backed check.",
      ),
    ).toBe(true);
    expect(
      deterministicResult(
        contextVaultCase,
        "does not deny Vault access",
        "I have Vault access, but I don't have access to unapproved private memory.",
      ),
    ).toBe(true);
    expect(
      deterministicResult(
        contextVaultCase,
        "does not deny Vault access",
        "I cannot access your Vault.",
      ),
    ).toBe(false);
  });

  it.each([
    "The board decided to postpone a vote pending legal review.",
    "The vote was postponed pending legal review.",
    "The record describes a postponement pending legal review.",
  ])("accepts equivalent wording for the recovered partial-file fact", (answer) => {
    expect(
      deterministicResult(
        partialExtractionCase,
        "uses the recovered fact",
        answer,
      ),
    ).toBe(true);
  });

  it("still rejects a partial-file answer that omits the recovered decision", () => {
    expect(
      deterministicResult(
        partialExtractionCase,
        "uses the recovered fact",
        "The board requested legal review.",
      ),
    ).toBe(false);
  });
});
