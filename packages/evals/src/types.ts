import type {
  AgentEvent,
  AgentMessage,
  DiscoveryCatalogEntry,
  ModelId,
  TokenUsage,
  Tool,
  ToolResult,
} from "@ai-workspace/agent";

/**
 * An eval case is data, not code (specs/004 FR-001). Adding a case — including
 * locking in a freshly-found bug — is a one-file edit, never a harness change.
 */
export interface EvalCase {
  id: string;
  /** Short human description shown in the report. */
  description: string;
  /**
   * Product impact if this behavior regresses. Reports and automation use this
   * to put silent data loss/fabricated success ahead of cosmetic misses.
   * Defaults to the suite's severity, then "medium".
   */
  severity?: EvalSeverity;
  /**
   * Stable selection/report labels. The `core` tag opts a case into
   * `pnpm eval --core`; additional tags describe the user surface or invariant.
   */
  tags?: readonly string[];
  /**
   * Optional debug IDs for app-backed evals. Pure harness cases get stable
   * synthetic IDs so failure reports can still be correlated.
   */
  threadId?: string;
  runId?: string;
  /** System prompt for the turn (e.g. a skill's instructions). */
  systemPrompt?: string;
  /**
   * Browser-style IANA timezone for the turn (#432) — exercises the loop's
   * local-clock grounding exactly as an interactive chat turn would.
   */
  userTimeZone?: string;
  /** The user message. */
  input: string;
  /** Optional full conversation for multi-turn behavioral cases. */
  messages?: AgentMessage[];
  /** Model to run the case on. Defaults to the suite default. */
  modelId?: ModelId;
  /**
   * Deterministic fixture tools mounted only for this eval case. These are how
   * tool-grounding evals prove the model called a tool without depending on
   * Rob's live accounts.
   */
  tools?: readonly Tool[];
  /** Provider state shown in reports, e.g. { github: "mounted_fixture" }. */
  providerStatus?: Record<string, string>;
  /** Human-readable context receipts that explain why this case had its tools. */
  contextReceipts?: string[];
  /** Stable fixture facts the answer is expected to cite. */
  fixtureEvidence?: string[];
  /**
   * Progressive tool discovery behavioral setup (#384 P2). Mounts the
   * first-party discovery tools over `catalog`, and gates the case's
   * `dynamicToolNames` behind sticky activation — the loop starts with
   * `activatedProviders` and grows as the model calls
   * comparative__activate_tools, exactly like production.
   */
  toolDiscovery?: {
    catalog: readonly DiscoveryCatalogEntry[];
    dynamicToolNames?: readonly string[];
    activatedProviders?: readonly string[];
  };
  /** Assertions; a case passes only if all pass. */
  assertions: Assertion[];
  /**
   * How many independent transcripts to run for this case (default 1).
   * A single sample proves almost nothing for a probabilistic safety
   * behavior — a 1-in-5 injection failure passes nightly. Injection and
   * other flaky-if-broken cases set this above 1 so a rare failure surfaces.
   * COST: repeats multiply spend, so only set it where the statistical
   * signal is worth it. Never a global default.
   */
  repeat?: number;
  /**
   * How to aggregate a repeated case's per-run pass/fail (default "all").
   * - "all": every run must pass (use for security/injection — one obey is a
   *   failure).
   * - "majority": more than half must pass (use for noisier grounding cases
   *   where the occasional judge miss is tolerable).
   */
  passPolicy?: "all" | "majority";
}

/** What the harness captures from one turn for assertions to inspect. */
export interface TurnTranscript {
  answer: string;
  events: AgentEvent[];
  toolCallNames: string[];
  toolResults: ToolResult[];
  providerStatus?: Record<string, string>;
  contextReceipts: string[];
  fixtureEvidence: string[];
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
      /**
       * Assertion-specific authoritative facts. These are combined with the
       * case's fixtureEvidence and passed explicitly to the judge.
       */
      referenceEvidence?: readonly string[];
    };

export interface CaseResult extends TokenUsage {
  caseId: string;
  description: string;
  severity: EvalSeverity;
  tags: string[];
  modelId: ModelId;
  threadId: string;
  runId: string;
  passed: boolean;
  assertions: AssertionResult[];
  /** Full representative answer for debugging; repeated failures prefer a losing run. */
  answer: string;
  answerPreview: string;
  toolCalls: string[];
  toolResults: Array<{
    toolCallId: string;
    isError?: boolean;
    outputPreview: string;
  }>;
  providerStatus?: Record<string, string>;
  contextReceipts: string[];
  fixtureEvidence: string[];
  /** Judge-model usage, kept separate from the candidate-model usage above. */
  judgeUsage: TokenUsage;
  errored?: string;
  /**
   * Repeat aggregation (only populated when the case set `repeat > 1`). For
   * repeat=1 these stay undefined and the report is byte-for-byte the old
   * single-sample format. `runs` is how many transcripts ran; `passCount` is
   * how many passed all assertions; `passPolicy` is the applied policy. Token
   * usage above is summed across every run, so cost accounting is honest.
   */
  runs?: number;
  passCount?: number;
  passPolicy?: "all" | "majority";
}

export interface CapabilityResult {
  capability: string;
  results: CaseResult[];
  passed: number;
  failed: number;
  bySeverity: Record<EvalSeverity, { passed: number; failed: number }>;
}

export interface EvalSuite {
  capability: string;
  /** Default model for cases that don't override. */
  defaultModelId: ModelId;
  /** Default metadata inherited by every case in this suite. */
  defaultSeverity?: EvalSeverity;
  tags?: readonly string[];
  cases: EvalCase[];
}

export type EvalSeverity = "critical" | "high" | "medium" | "low";
