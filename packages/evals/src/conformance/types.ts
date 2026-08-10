import type { ModelId } from "@ai-workspace/agent";
import type { RuntimeName } from "@ai-workspace/agent-runtime";

export const RUNTIME_CONFORMANCE_SCHEMA = "runtime-conformance.v1" as const;

export const CONFORMANCE_PROBE_IDS = [
  "basic-turn",
  "streaming",
  "text-input",
  "image-input",
  "business-file-input",
  "tool-loop",
  "policy-enforcement",
  "cancellation",
  "resume",
  "stream-recovery",
  "artifact-integrity",
  "usage-reporting",
  "queued-next-turn",
  "live-steering",
  "context-management",
  "child-runs",
  "sandbox-browser-console",
] as const;

export type ConformanceProbeId = (typeof CONFORMANCE_PROBE_IDS)[number];

export const ADVERTISED_FILE_CLASSES = [
  "text",
  "document",
  "spreadsheet",
  "presentation",
  "image",
] as const;

export type AdvertisedFileClass = (typeof ADVERTISED_FILE_CLASSES)[number];

export type ConformanceVerdict =
  | "SUPPORTED"
  | "UNSUPPORTED"
  | "PARTIAL"
  | "UNKNOWN"
  | "SKIPPED"
  | "DRIFT";

export type CapabilityDeclaration =
  | "supported"
  | "partial"
  | "unsupported"
  | "unknown";

export type ProbeRequirement = "required" | "capability-gated";

export type ConformanceFailureCategory =
  | "product"
  | "provider"
  | "credentials"
  | "unsupported"
  | "quota"
  | "harness";

export type ConformanceRunMode = "offline-contract" | "live" | "pre-enable";

export interface ConformanceLaneProvenance {
  lane: "fast-local" | "tool-local" | "durable-local";
  runtime: RuntimeName;
  modelId: ModelId;
  mode: ConformanceRunMode;
  appVersion: string;
  commitSha: string;
  runtimeImage: string;
  environment?: string;
}

export interface ConformanceCapabilityDeclaration {
  status: CapabilityDeclaration;
  source: string;
  note?: string;
}

export type ConformanceDeclarations = Record<
  ConformanceProbeId,
  ConformanceCapabilityDeclaration
>;

export interface BasicTurnEvidence {
  completed: boolean;
  assistantOutputPresent: boolean;
  persistedAssistantOutputs: number;
  terminalState: string;
}

export interface StreamingEvidence {
  textDeltaCount: number;
  firstTokenMs: number | null;
  completed: boolean;
}

export interface InputEvidence {
  accepted: boolean;
  contentObserved: boolean;
}

export interface BusinessFileInputEvidence {
  classes: Partial<
    Record<
      AdvertisedFileClass,
      { accepted: boolean; contentMounted: boolean; persisted: boolean }
    >
  >;
}

export interface ToolLoopEvidence {
  toolCallCount: number;
  toolResultCount: number;
  assistantContinuedAfterResult: boolean;
}

export interface PolicyEnforcementEvidence {
  allowedActionExecuted: boolean;
  approvalRequiredActionPaused: boolean;
  blockedActionPrevented: boolean;
  unauthorizedSideEffects: number;
}

export interface CancellationEvidence {
  cancellationAccepted: boolean;
  terminalState: string;
  postCancelAssistantOutputs: number;
  postCancelArtifacts: number;
  postCancelToolSideEffects: number;
}

export interface ResumeEvidence {
  disconnected: boolean;
  resumed: boolean;
  duplicateEventCount: number;
  terminalState: string;
}

export interface StreamRecoveryEvidence {
  malformedStreamHandled: boolean;
  interruptedStreamHandled: boolean;
  terminalStateRecorded: boolean;
}

export interface ArtifactIntegrityEvidence {
  artifactCreated: boolean;
  attachmentLinked: boolean;
  contentHashMatches: boolean;
}

export interface UsageReportingEvidence {
  usageEventPresent: boolean;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface QueuedNextTurnEvidence {
  accepted: boolean;
  deliveredExactlyOnce: boolean;
  orderPreserved: boolean;
}

export interface LiveSteeringEvidence {
  accepted: boolean;
  affectedCurrentTurn: boolean;
  persistedAsUserGuidance: boolean;
}

export interface ContextManagementEvidence {
  stayedWithinBudget: boolean;
  strategy: "compacted" | "bounded-fallback" | "none";
  receiptPresent: boolean;
}

export interface ChildRunEvidence {
  childEventsLinked: boolean;
  terminalStatesRecorded: boolean;
  aggregateUsageReported: boolean;
}

export interface SandboxEvidence {
  browserAvailable: boolean;
  consoleAvailable: boolean;
  isolated: boolean;
  egressPolicyEnforced: boolean;
}

export interface ConformanceProbeEvidenceById {
  "basic-turn": BasicTurnEvidence;
  streaming: StreamingEvidence;
  "text-input": InputEvidence;
  "image-input": InputEvidence;
  "business-file-input": BusinessFileInputEvidence;
  "tool-loop": ToolLoopEvidence;
  "policy-enforcement": PolicyEnforcementEvidence;
  cancellation: CancellationEvidence;
  resume: ResumeEvidence;
  "stream-recovery": StreamRecoveryEvidence;
  "artifact-integrity": ArtifactIntegrityEvidence;
  "usage-reporting": UsageReportingEvidence;
  "queued-next-turn": QueuedNextTurnEvidence;
  "live-steering": LiveSteeringEvidence;
  "context-management": ContextManagementEvidence;
  "child-runs": ChildRunEvidence;
  "sandbox-browser-console": SandboxEvidence;
}

export type ConformanceProbeExecution<K extends ConformanceProbeId> =
  | {
      outcome: "observed";
      evidence: ConformanceProbeEvidenceById[K];
      costUsd?: number;
    }
  | {
      outcome: "unsupported";
      summary: string;
      category?: "unsupported";
    }
  | {
      outcome: "skipped";
      summary: string;
      category: "credentials" | "quota" | "harness";
    }
  | {
      outcome: "failed";
      summary: string;
      category: "product" | "provider" | "harness";
      costUsd?: number;
    }
  | {
      outcome: "unknown";
      summary: string;
      category?: ConformanceFailureCategory;
    };

export interface RuntimeConformanceDriver {
  readonly provenance: ConformanceLaneProvenance;
  readonly declarations: ConformanceDeclarations;
  runProbe<K extends ConformanceProbeId>(
    probeId: K,
  ): Promise<ConformanceProbeExecution<K>>;
}

export interface ProbeValidation {
  status: "passed" | "partial" | "failed";
  summary: string;
  evidence: Record<string, string | number | boolean>;
}

export interface ConformanceProbeDefinition<K extends ConformanceProbeId> {
  id: K;
  title: string;
  requirement: ProbeRequirement;
  validate(evidence: ConformanceProbeEvidenceById[K]): ProbeValidation;
}

export interface ConformanceProbeResult {
  id: ConformanceProbeId;
  title: string;
  requirement: ProbeRequirement;
  declaration: CapabilityDeclaration;
  declarationSource: string;
  verdict: ConformanceVerdict;
  gateImpact: "pass" | "block" | "inconclusive";
  summary: string;
  evidence: Record<string, string | number | boolean>;
  durationMs: number;
  category?: ConformanceFailureCategory;
  costUsd: number;
}

export interface RuntimeConformanceReport {
  schema: typeof RUNTIME_CONFORMANCE_SCHEMA;
  reportId: string;
  provenance: ConformanceLaneProvenance;
  startedAt: string;
  finishedAt: string;
  budget: {
    maxProbes: number;
    maxCostUsd: number;
    executedProbes: number;
    observedCostUsd: number;
    exhausted: boolean;
  };
  results: ConformanceProbeResult[];
  gate: {
    contractPassed: boolean;
    eligibleForProduction: boolean;
    blockingProbeIds: ConformanceProbeId[];
    inconclusiveProbeIds: ConformanceProbeId[];
  };
  counts: Record<ConformanceVerdict, number>;
}

export interface RunConformanceOptions {
  maxProbes?: number;
  maxCostUsd?: number;
  now?: () => Date;
  reportId?: string;
}
