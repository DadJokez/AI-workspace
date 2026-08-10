import {
  DEFAULT_MODEL_ID,
  MODELS,
  type ModelId,
} from "@ai-workspace/agent";
import type {
  ConformanceDeclarations,
  ConformanceLaneProvenance,
  ConformanceProbeEvidenceById,
  ConformanceProbeExecution,
  ConformanceProbeId,
  RuntimeConformanceDriver,
} from "./types";

export const PASSING_PROBE_EVIDENCE: {
  [K in ConformanceProbeId]: ConformanceProbeEvidenceById[K];
} = {
  "basic-turn": {
    completed: true,
    assistantOutputPresent: true,
    persistedAssistantOutputs: 1,
    terminalState: "completed",
  },
  streaming: {
    textDeltaCount: 3,
    firstTokenMs: 125,
    completed: true,
  },
  "text-input": { accepted: true, contentObserved: true },
  "image-input": { accepted: true, contentObserved: true },
  "business-file-input": {
    classes: {
      text: { accepted: true, contentMounted: true, persisted: true },
      document: { accepted: true, contentMounted: true, persisted: true },
      spreadsheet: { accepted: true, contentMounted: true, persisted: true },
      presentation: { accepted: true, contentMounted: true, persisted: true },
      image: { accepted: true, contentMounted: true, persisted: true },
    },
  },
  "tool-loop": {
    toolCallCount: 1,
    toolResultCount: 1,
    assistantContinuedAfterResult: true,
  },
  "policy-enforcement": {
    allowedActionExecuted: true,
    approvalRequiredActionPaused: true,
    blockedActionPrevented: true,
    unauthorizedSideEffects: 0,
  },
  cancellation: {
    cancellationAccepted: true,
    terminalState: "canceled",
    postCancelAssistantOutputs: 0,
    postCancelArtifacts: 0,
    postCancelToolSideEffects: 0,
  },
  resume: {
    disconnected: true,
    resumed: true,
    duplicateEventCount: 0,
    terminalState: "completed",
  },
  "stream-recovery": {
    malformedStreamHandled: true,
    interruptedStreamHandled: true,
    terminalStateRecorded: true,
  },
  "artifact-integrity": {
    artifactCreated: true,
    attachmentLinked: true,
    contentHashMatches: true,
  },
  "usage-reporting": {
    usageEventPresent: true,
    tokensIn: 120,
    tokensOut: 40,
    costUsd: 0.001,
  },
  "queued-next-turn": {
    accepted: true,
    deliveredExactlyOnce: true,
    orderPreserved: true,
  },
  "live-steering": {
    accepted: true,
    affectedCurrentTurn: true,
    persistedAsUserGuidance: true,
  },
  "context-management": {
    stayedWithinBudget: true,
    strategy: "bounded-fallback",
    receiptPresent: true,
  },
  "child-runs": {
    childEventsLinked: true,
    terminalStatesRecorded: true,
    aggregateUsageReported: true,
  },
  "sandbox-browser-console": {
    browserAvailable: true,
    consoleAvailable: true,
    isolated: true,
    egressPolicyEnforced: true,
  },
};

export function createCurrentDeclarations({
  modelId = DEFAULT_MODEL_ID,
  liveTurnSteering = false,
}: {
  modelId?: ModelId;
  liveTurnSteering?: boolean;
} = {}): ConformanceDeclarations {
  const model = MODELS[modelId];
  const requiredSource = "Contribution Studio runtime contract #744";
  return {
    "basic-turn": { status: "supported", source: requiredSource },
    streaming: {
      status: model.supportsStreaming ? "supported" : "unsupported",
      source: `Model registry: ${modelId}.supportsStreaming`,
    },
    "text-input": { status: "supported", source: requiredSource },
    "image-input": {
      status: model.supportsVision ? "supported" : "unsupported",
      source: `Model registry: ${modelId}.supportsVision`,
    },
    "business-file-input": { status: "supported", source: requiredSource },
    "tool-loop": {
      status: model.supportsToolUse ? "supported" : "unsupported",
      source: `Model registry: ${modelId}.supportsToolUse`,
    },
    "policy-enforcement": { status: "supported", source: requiredSource },
    cancellation: { status: "supported", source: requiredSource },
    resume: { status: "supported", source: requiredSource },
    "stream-recovery": { status: "supported", source: requiredSource },
    "artifact-integrity": { status: "supported", source: requiredSource },
    "usage-reporting": { status: "supported", source: requiredSource },
    "queued-next-turn": {
      status: "supported",
      source: "Chat turn queue and persisted draft contract #737",
    },
    "live-steering": {
      status: liveTurnSteering ? "supported" : "unsupported",
      source: "AgentRuntime.capabilities.liveTurnSteering",
      ...(!liveTurnSteering
        ? {
            note:
              "Accepted guidance becomes the next turn on current AWS lanes.",
          }
        : {}),
    },
    "context-management": {
      status: "supported",
      source: "Bounded chat context and context receipt contract",
    },
    "child-runs": {
      status: "unsupported",
      source: "No production child-run capability is currently advertised.",
    },
    "sandbox-browser-console": {
      status: "unsupported",
      source: "No production Browser/Console sandbox is currently advertised.",
    },
  };
}

/**
 * Deterministic driver for normal CI. It proves every probe validator,
 * declaration reconciliation path, budget, and report renderer without
 * touching a model. Its provenance deliberately prevents production
 * enablement; live/pre-enable drivers must supply their own observations.
 */
export class OfflineContractDriver implements RuntimeConformanceDriver {
  readonly provenance: ConformanceLaneProvenance;
  readonly declarations: ConformanceDeclarations;

  constructor({
    provenance,
    declarations,
  }: {
    provenance: ConformanceLaneProvenance;
    declarations?: ConformanceDeclarations;
  }) {
    if (provenance.mode !== "offline-contract") {
      throw new Error("OfflineContractDriver requires offline-contract provenance.");
    }
    this.provenance = provenance;
    this.declarations =
      declarations ?? createCurrentDeclarations({ modelId: provenance.modelId });
  }

  async runProbe<K extends ConformanceProbeId>(
    probeId: K,
  ): Promise<ConformanceProbeExecution<K>> {
    return {
      outcome: "observed",
      evidence: PASSING_PROBE_EVIDENCE[probeId],
      costUsd: 0,
    };
  }
}
