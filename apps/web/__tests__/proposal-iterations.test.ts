import { describe, expect, it } from "vitest";
import {
  formatProposalIterationMessage,
  normalizeProposalIterationFeedback,
  parseProposalIterationTarget,
  PROPOSAL_ITERATION_MAX_FEEDBACK_CHARS,
} from "@/lib/output-proposals";
import {
  outputProposalContextForIteration,
  proposalIterationFromRunInputs,
  proposalIterationLineage,
  type StoredProposalIteration,
} from "@/lib/proposal-iterations";

const iteration: StoredProposalIteration = {
  kind: "app",
  runId: "iteration-run",
  sourceArtifactId: "artifact-source",
  sourceArtifactGroupId: "artifact-group",
  sourceRunId: "source-run",
  sourceTriggerType: "scheduled",
  sourceThreadId: "thread-1",
  feedbackMessageId: "feedback-message",
  requestedAt: "2026-07-23T12:00:00.000Z",
  requestedByUserId: "user-1",
  sourceAppId: "app-1",
  sourceAppVersionId: "version-1",
};

describe("proposal iteration request contract", () => {
  it("normalizes concise feedback and bounds persisted input", () => {
    expect(
      normalizeProposalIterationFeedback("  Use   the new brand colors. \n"),
    ).toBe("Use the new brand colors.");
    expect(
      normalizeProposalIterationFeedback(
        "x".repeat(PROPOSAL_ITERATION_MAX_FEEDBACK_CHARS + 50),
      ),
    ).toHaveLength(PROPOSAL_ITERATION_MAX_FEEDBACK_CHARS);
    expect(normalizeProposalIterationFeedback("   ")).toBeNull();
  });

  it("parses only complete artifact and app targets", () => {
    expect(
      parseProposalIterationTarget({
        kind: "artifact",
        artifactId: "artifact-1",
      }),
    ).toEqual({ kind: "artifact", artifactId: "artifact-1" });
    expect(
      parseProposalIterationTarget({
        kind: "app",
        appId: "app-1",
        appVersionId: "version-1",
      }),
    ).toEqual({
      kind: "app",
      appId: "app-1",
      appVersionId: "version-1",
    });
    expect(
      parseProposalIterationTarget({ kind: "app", appId: "app-1" }),
    ).toBeNull();
  });

  it("round-trips stored app lineage into the replacement proposal", () => {
    expect(
      proposalIterationFromRunInputs({ proposalIteration: iteration }),
    ).toEqual(iteration);
    expect(proposalIterationLineage(iteration)).toEqual({
      sourceArtifactId: "artifact-source",
      sourceRunId: "source-run",
      feedbackMessageId: "feedback-message",
      requestedAt: "2026-07-23T12:00:00.000Z",
      requestedByUserId: "user-1",
      sourceAppId: "app-1",
      sourceAppVersionId: "version-1",
    });
    expect(
      outputProposalContextForIteration(
        iteration,
        new Date("2026-07-23T12:05:00.000Z"),
      ),
    ).toMatchObject({
      runId: "iteration-run",
      triggerType: "scheduled",
      createdAt: "2026-07-23T12:05:00.000Z",
      iterationOf: {
        sourceArtifactId: "artifact-source",
        sourceAppVersionId: "version-1",
      },
    });
  });

  it("uses a canonical visible chat message without embedding hidden context", () => {
    expect(
      formatProposalIterationMessage({
        label: "Revenue Dashboard",
        feedback: "Make the forecast variance easier to scan.",
      }),
    ).toBe(
      "Iterate on Revenue Dashboard: Make the forecast variance easier to scan.",
    );
  });
});
