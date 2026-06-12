import type { AgentEvent, ModelId } from "@ai-workspace/agent";

/**
 * An eval case is data, not code (specs/004 FR-001). Adding a case — including
 * locking in a freshly-found bug — is a one-file edit, never a harness change.
 */
export interface EvalCase {
  id: string;
  /** Short human description shown in the report. */
  description: string;
  /** System prompt for the turn (e.g. a skill's instructions). */
  systemPrompt?: string;
  /** The user message. */
  input: string;
  /** Model to run the case on. Defaults to the suite default. */
  modelId?: ModelId;
  /** Assertions; a case passes only if all pass. */
  assertions: Assertion[];
}

/** What the harness captures from one turn for assertions to inspect. */
export interface TurnTranscript {
  answer: string;
  events: AgentEvent[];
  toolCallNames: string[];
}

export interface AssertionResult {
  ok: boolean;
  label: string;
  detail?: string;
}

/**
 * Two kinds, per FR-002: deterministic predicates run in-process (free,
 * exact); `judge` assertions defer to a Haiku rubric for qualitative calls.
 * Both share this shape so a case lists them uniformly.
 */
export type Assertion =
  | {
      kind: "deterministic";
      label: string;
      check: (t: TurnTranscript) => boolean | { ok: boolean; detail?: string };
    }
  | {
      kind: "judge";
      label: string;
      /** Rubric question the judge answers yes/no about the answer. */
      rubric: string;
    };

export interface CaseResult {
  caseId: string;
  description: string;
  passed: boolean;
  assertions: AssertionResult[];
  answerPreview: string;
  tokensIn: number;
  tokensOut: number;
  errored?: string;
}

export interface CapabilityResult {
  capability: string;
  results: CaseResult[];
  passed: number;
  failed: number;
}

export interface EvalSuite {
  capability: string;
  /** Default model for cases that don't override. */
  defaultModelId: ModelId;
  cases: EvalCase[];
}
