import {
  ADVERTISED_FILE_CLASSES,
  type ConformanceProbeDefinition,
  type ConformanceProbeEvidenceById,
  type ConformanceProbeId,
  type ProbeValidation,
} from "./types";

function validation(
  ok: boolean,
  summary: string,
  evidence: ProbeValidation["evidence"],
): ProbeValidation {
  return { status: ok ? "passed" : "failed", summary, evidence };
}

const basicTurn: ConformanceProbeDefinition<"basic-turn"> = {
  id: "basic-turn",
  title: "Basic turn and persistence",
  requirement: "required",
  validate(evidence) {
    const ok =
      evidence.completed &&
      evidence.assistantOutputPresent &&
      evidence.persistedAssistantOutputs === 1 &&
      evidence.terminalState === "completed";
    return validation(
      ok,
      ok
        ? "Turn completed with exactly one persisted assistant output."
        : "Turn completion or assistant persistence contract failed.",
      {
        completed: evidence.completed,
        assistantOutputPresent: evidence.assistantOutputPresent,
        persistedAssistantOutputs: evidence.persistedAssistantOutputs,
        terminalState: evidence.terminalState,
      },
    );
  },
};

const streaming: ConformanceProbeDefinition<"streaming"> = {
  id: "streaming",
  title: "Multi-delta streaming and first token",
  requirement: "required",
  validate(evidence) {
    const validFirstToken =
      evidence.firstTokenMs !== null &&
      Number.isFinite(evidence.firstTokenMs) &&
      evidence.firstTokenMs >= 0;
    const ok =
      evidence.completed && evidence.textDeltaCount >= 2 && validFirstToken;
    return validation(
      ok,
      ok
        ? "Multiple deltas streamed and first-token latency was recorded."
        : "Streaming did not produce multiple deltas with valid first-token timing.",
      {
        completed: evidence.completed,
        textDeltaCount: evidence.textDeltaCount,
        firstTokenMs: evidence.firstTokenMs ?? "missing",
      },
    );
  },
};

function inputProbe<K extends "text-input" | "image-input">(
  id: K,
  title: string,
): ConformanceProbeDefinition<K> {
  return {
    id,
    title,
    requirement: "required",
    validate(evidence) {
      const ok = evidence.accepted && evidence.contentObserved;
      return validation(
        ok,
        ok
          ? "Input was accepted and its content reached the turn."
          : "Input was dropped, rejected, or not observed by the turn.",
        {
          accepted: evidence.accepted,
          contentObserved: evidence.contentObserved,
        },
      );
    },
  };
}

const businessFileInput: ConformanceProbeDefinition<"business-file-input"> = {
  id: "business-file-input",
  title: "Advertised business-file inputs",
  requirement: "required",
  validate(evidence) {
    const covered = ADVERTISED_FILE_CLASSES.filter((fileClass) => {
      const result = evidence.classes[fileClass];
      return result?.accepted && result.contentMounted && result.persisted;
    });
    const missing = ADVERTISED_FILE_CLASSES.filter(
      (fileClass) => !covered.includes(fileClass),
    );
    const status =
      covered.length === ADVERTISED_FILE_CLASSES.length
        ? "passed"
        : covered.length > 0
          ? "partial"
          : "failed";
    return {
      status,
      summary:
        missing.length === 0
          ? "Every advertised file class was accepted, mounted, and persisted."
          : `Missing complete coverage for: ${missing.join(", ")}.`,
      evidence: {
        advertisedClasses: ADVERTISED_FILE_CLASSES.length,
        coveredClasses: covered.length,
        missingClasses: missing.join(", ") || "none",
      },
    };
  },
};

const toolLoop: ConformanceProbeDefinition<"tool-loop"> = {
  id: "tool-loop",
  title: "Tool call, result, and continuation",
  requirement: "required",
  validate(evidence) {
    const ok =
      evidence.toolCallCount > 0 &&
      evidence.toolResultCount >= evidence.toolCallCount &&
      evidence.assistantContinuedAfterResult;
    return validation(
      ok,
      ok
        ? "The runtime completed a tool loop and continued the answer."
        : "The tool call, result, or assistant continuation was missing.",
      {
        toolCallCount: evidence.toolCallCount,
        toolResultCount: evidence.toolResultCount,
        assistantContinuedAfterResult: evidence.assistantContinuedAfterResult,
      },
    );
  },
};

const policyEnforcement: ConformanceProbeDefinition<"policy-enforcement"> = {
  id: "policy-enforcement",
  title: "Allow, approval, and block policy",
  requirement: "required",
  validate(evidence) {
    const ok =
      evidence.allowedActionExecuted &&
      evidence.approvalRequiredActionPaused &&
      evidence.blockedActionPrevented &&
      evidence.unauthorizedSideEffects === 0;
    return validation(
      ok,
      ok
        ? "Allow, approval-required, and block decisions were enforced."
        : "One or more deterministic policy decisions were not enforced.",
      {
        allowedActionExecuted: evidence.allowedActionExecuted,
        approvalRequiredActionPaused: evidence.approvalRequiredActionPaused,
        blockedActionPrevented: evidence.blockedActionPrevented,
        unauthorizedSideEffects: evidence.unauthorizedSideEffects,
      },
    );
  },
};

const cancellation: ConformanceProbeDefinition<"cancellation"> = {
  id: "cancellation",
  title: "Cancellation without later persistence",
  requirement: "required",
  validate(evidence) {
    const ok =
      evidence.cancellationAccepted &&
      evidence.terminalState === "canceled" &&
      evidence.postCancelAssistantOutputs === 0 &&
      evidence.postCancelArtifacts === 0 &&
      evidence.postCancelToolSideEffects === 0;
    return validation(
      ok,
      ok
        ? "Cancellation reached a terminal state with no later output or side effects."
        : "Canceled work continued or persisted output after cancellation.",
      {
        cancellationAccepted: evidence.cancellationAccepted,
        terminalState: evidence.terminalState,
        postCancelAssistantOutputs: evidence.postCancelAssistantOutputs,
        postCancelArtifacts: evidence.postCancelArtifacts,
        postCancelToolSideEffects: evidence.postCancelToolSideEffects,
      },
    );
  },
};

const resume: ConformanceProbeDefinition<"resume"> = {
  id: "resume",
  title: "Reconnect and resume",
  requirement: "required",
  validate(evidence) {
    const ok =
      evidence.disconnected &&
      evidence.resumed &&
      evidence.duplicateEventCount === 0 &&
      evidence.terminalState === "completed";
    return validation(
      ok,
      ok
        ? "The interrupted run resumed once and reached a terminal state."
        : "Reconnect/resume duplicated events or failed to complete.",
      {
        disconnected: evidence.disconnected,
        resumed: evidence.resumed,
        duplicateEventCount: evidence.duplicateEventCount,
        terminalState: evidence.terminalState,
      },
    );
  },
};

const streamRecovery: ConformanceProbeDefinition<"stream-recovery"> = {
  id: "stream-recovery",
  title: "Malformed and interrupted stream handling",
  requirement: "required",
  validate(evidence) {
    const ok =
      evidence.malformedStreamHandled &&
      evidence.interruptedStreamHandled &&
      evidence.terminalStateRecorded;
    return validation(
      ok,
      ok
        ? "Malformed and interrupted streams failed safely with terminal state."
        : "Stream corruption or interruption was not handled safely.",
      {
        malformedStreamHandled: evidence.malformedStreamHandled,
        interruptedStreamHandled: evidence.interruptedStreamHandled,
        terminalStateRecorded: evidence.terminalStateRecorded,
      },
    );
  },
};

const artifactIntegrity: ConformanceProbeDefinition<"artifact-integrity"> = {
  id: "artifact-integrity",
  title: "Artifact creation and attachment integrity",
  requirement: "required",
  validate(evidence) {
    const ok =
      evidence.artifactCreated &&
      evidence.attachmentLinked &&
      evidence.contentHashMatches;
    return validation(
      ok,
      ok
        ? "The artifact was created, linked, and content-verified."
        : "Artifact persistence, linkage, or content integrity failed.",
      {
        artifactCreated: evidence.artifactCreated,
        attachmentLinked: evidence.attachmentLinked,
        contentHashMatches: evidence.contentHashMatches,
      },
    );
  },
};

const usageReporting: ConformanceProbeDefinition<"usage-reporting"> = {
  id: "usage-reporting",
  title: "Usage, token, and cost reporting",
  requirement: "required",
  validate(evidence) {
    const valuesValid =
      Number.isFinite(evidence.tokensIn) &&
      evidence.tokensIn >= 0 &&
      Number.isFinite(evidence.tokensOut) &&
      evidence.tokensOut > 0 &&
      Number.isFinite(evidence.costUsd) &&
      evidence.costUsd >= 0;
    const ok = evidence.usageEventPresent && valuesValid;
    return validation(
      ok,
      ok
        ? "Usage and non-negative cost were reported."
        : "Usage, token counts, or cost reporting was missing or invalid.",
      {
        usageEventPresent: evidence.usageEventPresent,
        tokensIn: evidence.tokensIn,
        tokensOut: evidence.tokensOut,
        costUsd: evidence.costUsd,
      },
    );
  },
};

const queuedNextTurn: ConformanceProbeDefinition<"queued-next-turn"> = {
  id: "queued-next-turn",
  title: "Queued next-turn delivery",
  requirement: "capability-gated",
  validate(evidence) {
    const ok =
      evidence.accepted &&
      evidence.deliveredExactlyOnce &&
      evidence.orderPreserved;
    return validation(
      ok,
      ok
        ? "Queued guidance was delivered exactly once in order."
        : "Queued guidance was dropped, duplicated, or reordered.",
      { ...evidence },
    );
  },
};

const liveSteering: ConformanceProbeDefinition<"live-steering"> = {
  id: "live-steering",
  title: "Live in-flight steering",
  requirement: "capability-gated",
  validate(evidence) {
    const passed =
      evidence.accepted &&
      evidence.affectedCurrentTurn &&
      evidence.persistedAsUserGuidance;
    const partial =
      evidence.accepted &&
      (evidence.affectedCurrentTurn || evidence.persistedAsUserGuidance);
    return {
      status: passed ? "passed" : partial ? "partial" : "failed",
      summary: passed
        ? "Steering affected the active turn and remained attributable."
        : partial
          ? "Steering was accepted but only part of the contract held."
          : "Live steering did not affect the active turn safely.",
      evidence: { ...evidence },
    };
  },
};

const contextManagement: ConformanceProbeDefinition<"context-management"> = {
  id: "context-management",
  title: "Context compaction or bounded fallback",
  requirement: "capability-gated",
  validate(evidence) {
    const ok =
      evidence.stayedWithinBudget &&
      evidence.strategy !== "none" &&
      evidence.receiptPresent;
    return validation(
      ok,
      ok
        ? "Context stayed bounded with an inspectable strategy receipt."
        : "Context exceeded its budget or lacked a truthful strategy receipt.",
      { ...evidence },
    );
  },
};

const childRuns: ConformanceProbeDefinition<"child-runs"> = {
  id: "child-runs",
  title: "Child-run events and accounting",
  requirement: "capability-gated",
  validate(evidence) {
    const ok =
      evidence.childEventsLinked &&
      evidence.terminalStatesRecorded &&
      evidence.aggregateUsageReported;
    return validation(
      ok,
      ok
        ? "Child runs were linked, terminal, and included in usage."
        : "Child-run lineage, terminal state, or usage accounting failed.",
      { ...evidence },
    );
  },
};

const sandbox: ConformanceProbeDefinition<"sandbox-browser-console"> = {
  id: "sandbox-browser-console",
  title: "Sandbox Browser and Console",
  requirement: "capability-gated",
  validate(evidence) {
    const ok =
      evidence.browserAvailable &&
      evidence.consoleAvailable &&
      evidence.isolated &&
      evidence.egressPolicyEnforced;
    return validation(
      ok,
      ok
        ? "Browser and Console ran in an isolated, policy-bound sandbox."
        : "Sandbox capability or its isolation policy failed.",
      { ...evidence },
    );
  },
};

export const CONFORMANCE_PROBES = [
  basicTurn,
  streaming,
  inputProbe("text-input", "Text input"),
  inputProbe("image-input", "Image input"),
  businessFileInput,
  toolLoop,
  policyEnforcement,
  cancellation,
  resume,
  streamRecovery,
  artifactIntegrity,
  usageReporting,
  queuedNextTurn,
  liveSteering,
  contextManagement,
  childRuns,
  sandbox,
] as const;

export function getConformanceProbe<K extends ConformanceProbeId>(
  id: K,
): ConformanceProbeDefinition<K> {
  const probe = CONFORMANCE_PROBES.find((candidate) => candidate.id === id);
  if (!probe) throw new Error(`Unknown conformance probe: ${id}`);
  return probe as ConformanceProbeDefinition<K>;
}

export function validateConformanceProbe<K extends ConformanceProbeId>(
  id: K,
  evidence: ConformanceProbeEvidenceById[K],
): ProbeValidation {
  return getConformanceProbe(id).validate(evidence);
}
