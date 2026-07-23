export const UNATTENDED_OUTPUT_TRIGGER_TYPES = [
  "scheduled",
  "github_event",
] as const;

export type UnattendedOutputTriggerType =
  (typeof UNATTENDED_OUTPUT_TRIGGER_TYPES)[number];
export type OutputProposalStatus = "proposed" | "accepted" | "discarded";
export type OutputProposalDecision = Exclude<
  OutputProposalStatus,
  "proposed"
>;

export interface OutputProposalContext {
  runId: string;
  triggerType: UnattendedOutputTriggerType;
  createdAt: string;
}

export interface OutputProposalMetadata extends OutputProposalContext {
  status: OutputProposalStatus;
  decidedAt?: string;
  decidedByUserId?: string;
  reason?: string;
}

const MAX_PROPOSAL_REASON_CHARS = 500;

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
  return {
    runId: proposal.runId,
    triggerType,
    createdAt: proposal.createdAt,
    status: proposal.status,
    ...(typeof proposal.decidedAt === "string"
      ? { decidedAt: proposal.decidedAt }
      : {}),
    ...(typeof proposal.decidedByUserId === "string"
      ? { decidedByUserId: proposal.decidedByUserId }
      : {}),
    ...(typeof proposal.reason === "string"
      ? { reason: proposal.reason }
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
    value === "proposed" || value === "accepted" || value === "discarded"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
