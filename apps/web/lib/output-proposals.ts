export const UNATTENDED_OUTPUT_TRIGGER_TYPES = [
  "scheduled",
  "github_event",
] as const;

export type UnattendedOutputTriggerType =
  (typeof UNATTENDED_OUTPUT_TRIGGER_TYPES)[number];
export type OutputProposalStatus =
  | "proposed"
  | "iterating"
  | "accepted"
  | "discarded"
  | "superseded";
export type OutputProposalDecision = "accepted" | "discarded";
export const PROPOSAL_ITERATION_MAX_FEEDBACK_CHARS = 500;

export type ProposalIterationTarget =
  | { kind: "artifact"; artifactId: string }
  | { kind: "app"; appId: string; appVersionId: string };

export interface OutputProposalIterationLineage {
  sourceArtifactId: string;
  sourceRunId: string;
  feedbackMessageId: string;
  requestedAt: string;
  requestedByUserId: string;
  sourceAppId?: string;
  sourceAppVersionId?: string;
}

export interface OutputProposalIterationReservation {
  runId: string;
  feedbackMessageId: string;
  requestedAt: string;
  requestedByUserId: string;
}

export interface OutputProposalContext {
  runId: string;
  triggerType: UnattendedOutputTriggerType;
  createdAt: string;
  iterationOf?: OutputProposalIterationLineage;
}

export interface OutputProposalMetadata extends OutputProposalContext {
  status: OutputProposalStatus;
  decidedAt?: string;
  decidedByUserId?: string;
  reason?: string;
  iteration?: OutputProposalIterationReservation;
  replacedByArtifactId?: string;
}

const MAX_PROPOSAL_REASON_CHARS = 500;

export function normalizeProposalIterationFeedback(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, PROPOSAL_ITERATION_MAX_FEEDBACK_CHARS);
}

export function parseProposalIterationTarget(
  value: unknown,
): ProposalIterationTarget | null {
  if (!isRecord(value)) return null;
  if (value.kind === "artifact" && isNonEmptyString(value.artifactId)) {
    return { kind: "artifact", artifactId: value.artifactId };
  }
  if (
    value.kind === "app" &&
    isNonEmptyString(value.appId) &&
    isNonEmptyString(value.appVersionId)
  ) {
    return {
      kind: "app",
      appId: value.appId,
      appVersionId: value.appVersionId,
    };
  }
  return null;
}

export function formatProposalIterationMessage({
  label,
  feedback,
}: {
  label: string;
  feedback: string;
}): string {
  return `Iterate on ${label}: ${feedback}`;
}

export function unattendedOutputTriggerType(
  value: unknown,
): UnattendedOutputTriggerType | null {
  return value === "scheduled" || value === "github_event" ? value : null;
}

export function outputProposalContext({
  runId,
  triggerType,
  createdAt,
}: {
  runId: string;
  triggerType: unknown;
  createdAt: Date;
}): OutputProposalContext | null {
  const unattendedTrigger = unattendedOutputTriggerType(triggerType);
  if (!unattendedTrigger) return null;
  return {
    runId,
    triggerType: unattendedTrigger,
    createdAt: createdAt.toISOString(),
  };
}

export function outputProposalFromMetadata(
  metadata: unknown,
): OutputProposalMetadata | null {
  if (!isRecord(metadata) || !isRecord(metadata.outputProposal)) return null;
  const proposal = metadata.outputProposal;
  const triggerType = unattendedOutputTriggerType(proposal.triggerType);
  if (
    !triggerType ||
    typeof proposal.runId !== "string" ||
    typeof proposal.createdAt !== "string" ||
    !isOutputProposalStatus(proposal.status)
  ) {
    return null;
  }
  const iterationOf = parseIterationLineage(proposal.iterationOf);
  const iteration = parseIterationReservation(proposal.iteration);
  return {
    runId: proposal.runId,
    triggerType,
    createdAt: proposal.createdAt,
    status: proposal.status,
    ...(iterationOf ? { iterationOf } : {}),
    ...(iteration ? { iteration } : {}),
    ...(typeof proposal.decidedAt === "string"
      ? { decidedAt: proposal.decidedAt }
      : {}),
    ...(typeof proposal.decidedByUserId === "string"
      ? { decidedByUserId: proposal.decidedByUserId }
      : {}),
    ...(typeof proposal.reason === "string"
      ? { reason: proposal.reason }
      : {}),
    ...(typeof proposal.replacedByArtifactId === "string"
      ? { replacedByArtifactId: proposal.replacedByArtifactId }
      : {}),
  };
}

export function withOutputProposal(
  metadata: Record<string, unknown>,
  context: OutputProposalContext | null | undefined,
): Record<string, unknown> {
  if (!context) return metadata;
  return {
    ...metadata,
    outputProposal: {
      ...context,
      status: "proposed",
    } satisfies OutputProposalMetadata,
  };
}

export function decideOutputProposalMetadata({
  metadata,
  decision,
  decidedAt,
  decidedByUserId,
  reason,
}: {
  metadata: unknown;
  decision: OutputProposalDecision;
  decidedAt: Date;
  decidedByUserId: string;
  reason?: string | null;
}): Record<string, unknown> | null {
  const proposal = outputProposalFromMetadata(metadata);
  if (!proposal || proposal.status !== "proposed") return null;
  const normalizedMetadata = isRecord(metadata) ? metadata : {};
  const normalizedReason = normalizeProposalReason(reason);
  return {
    ...normalizedMetadata,
    outputProposal: {
      ...proposal,
      status: decision,
      decidedAt: decidedAt.toISOString(),
      decidedByUserId,
      ...(normalizedReason ? { reason: normalizedReason } : {}),
    } satisfies OutputProposalMetadata,
  };
}

export function reserveOutputProposalIterationMetadata({
  metadata,
  reservation,
}: {
  metadata: unknown;
  reservation: OutputProposalIterationReservation;
}): Record<string, unknown> | null {
  const proposal = outputProposalFromMetadata(metadata);
  if (!proposal || proposal.status !== "proposed") return null;
  const normalizedMetadata = isRecord(metadata) ? metadata : {};
  return {
    ...normalizedMetadata,
    outputProposal: {
      ...proposal,
      status: "iterating",
      iteration: reservation,
    } satisfies OutputProposalMetadata,
  };
}

export function releaseOutputProposalIterationMetadata({
  metadata,
  runId,
}: {
  metadata: unknown;
  runId: string;
}): Record<string, unknown> | null {
  const proposal = outputProposalFromMetadata(metadata);
  if (
    !proposal ||
    proposal.status !== "iterating" ||
    proposal.iteration?.runId !== runId
  ) {
    return null;
  }
  const normalizedMetadata = isRecord(metadata) ? metadata : {};
  const releasedProposal = { ...proposal };
  delete releasedProposal.iteration;
  return {
    ...normalizedMetadata,
    outputProposal: {
      ...releasedProposal,
      status: "proposed",
    } satisfies OutputProposalMetadata,
  };
}

export function supersedeOutputProposalMetadata({
  metadata,
  runId,
  replacementArtifactId,
  decidedAt,
  decidedByUserId,
}: {
  metadata: unknown;
  runId: string;
  replacementArtifactId: string;
  decidedAt: Date;
  decidedByUserId: string;
}): Record<string, unknown> | null {
  const proposal = outputProposalFromMetadata(metadata);
  if (
    !proposal ||
    proposal.status !== "iterating" ||
    proposal.iteration?.runId !== runId
  ) {
    return null;
  }
  const normalizedMetadata = isRecord(metadata) ? metadata : {};
  return {
    ...normalizedMetadata,
    outputProposal: {
      ...proposal,
      status: "superseded",
      decidedAt: decidedAt.toISOString(),
      decidedByUserId,
      replacedByArtifactId: replacementArtifactId,
    } satisfies OutputProposalMetadata,
  };
}

export function normalizeProposalReason(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_PROPOSAL_REASON_CHARS);
}

export function isOutputProposalStatus(
  value: unknown,
): value is OutputProposalStatus {
  return (
    value === "proposed" ||
    value === "iterating" ||
    value === "accepted" ||
    value === "discarded" ||
    value === "superseded"
  );
}

function parseIterationLineage(
  value: unknown,
): OutputProposalIterationLineage | null {
  if (
    !isRecord(value) ||
    typeof value.sourceArtifactId !== "string" ||
    typeof value.sourceRunId !== "string" ||
    typeof value.feedbackMessageId !== "string" ||
    typeof value.requestedAt !== "string" ||
    typeof value.requestedByUserId !== "string"
  ) {
    return null;
  }
  return {
    sourceArtifactId: value.sourceArtifactId,
    sourceRunId: value.sourceRunId,
    feedbackMessageId: value.feedbackMessageId,
    requestedAt: value.requestedAt,
    requestedByUserId: value.requestedByUserId,
    ...(typeof value.sourceAppId === "string"
      ? { sourceAppId: value.sourceAppId }
      : {}),
    ...(typeof value.sourceAppVersionId === "string"
      ? { sourceAppVersionId: value.sourceAppVersionId }
      : {}),
  };
}

function parseIterationReservation(
  value: unknown,
): OutputProposalIterationReservation | null {
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    typeof value.feedbackMessageId !== "string" ||
    typeof value.requestedAt !== "string" ||
    typeof value.requestedByUserId !== "string"
  ) {
    return null;
  }
  return {
    runId: value.runId,
    feedbackMessageId: value.feedbackMessageId,
    requestedAt: value.requestedAt,
    requestedByUserId: value.requestedByUserId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
