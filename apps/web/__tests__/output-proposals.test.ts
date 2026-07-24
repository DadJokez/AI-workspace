import { describe, expect, it } from "vitest";
import {
  decideOutputProposalMetadata,
  outputProposalContext,
  outputProposalFromMetadata,
  releaseOutputProposalIterationMetadata,
  reserveOutputProposalIterationMetadata,
  supersedeOutputProposalMetadata,
  withOutputProposal,
} from "@/lib/output-proposals";

const RUN_ID = "00000000-0000-4000-8000-000000000437";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const CREATED_AT = new Date("2026-07-23T12:00:00.000Z");

describe("output proposals", () => {
  it.each(["scheduled", "github_event"])(
    "classifies %s worker output as a proposal",
    (triggerType) => {
      const context = outputProposalContext({
        runId: RUN_ID,
        triggerType,
        createdAt: CREATED_AT,
      });

      expect(context).toEqual({
        runId: RUN_ID,
        triggerType,
        createdAt: CREATED_AT.toISOString(),
      });
      expect(
        outputProposalFromMetadata(withOutputProposal({ lineDelta: "+2 -1" }, context)),
      ).toMatchObject({
        runId: RUN_ID,
        triggerType,
        status: "proposed",
      });
    },
  );

  it.each(["chat", "chat_retry", "skill", "manual", undefined])(
    "leaves %s output on the normal path",
    (triggerType) => {
      expect(
        outputProposalContext({
          runId: RUN_ID,
          triggerType,
          createdAt: CREATED_AT,
        }),
      ).toBeNull();
    },
  );

  it("accepts a pending proposal without losing existing artifact metadata", () => {
    const metadata = withOutputProposal(
      { lineDelta: { added: 3, removed: 1 } },
      {
        runId: RUN_ID,
        triggerType: "scheduled",
        createdAt: CREATED_AT.toISOString(),
      },
    );

    const updated = decideOutputProposalMetadata({
      metadata,
      decision: "accepted",
      decidedAt: new Date("2026-07-23T12:05:00.000Z"),
      decidedByUserId: USER_ID,
    });

    expect(updated).toMatchObject({
      lineDelta: { added: 3, removed: 1 },
      outputProposal: {
        status: "accepted",
        decidedByUserId: USER_ID,
        decidedAt: "2026-07-23T12:05:00.000Z",
      },
    });
  });

  it("archives a discarded proposal with a bounded reason and prevents a second decision", () => {
    const metadata = withOutputProposal(
      {},
      {
        runId: RUN_ID,
        triggerType: "github_event",
        createdAt: CREATED_AT.toISOString(),
      },
    );
    const discarded = decideOutputProposalMetadata({
      metadata,
      decision: "discarded",
      decidedAt: new Date("2026-07-23T12:06:00.000Z"),
      decidedByUserId: USER_ID,
      reason: `  ${"x".repeat(600)}  `,
    });

    expect(
      outputProposalFromMetadata(discarded)?.reason,
    ).toHaveLength(500);
    expect(
      decideOutputProposalMetadata({
        metadata: discarded,
        decision: "accepted",
        decidedAt: new Date("2026-07-23T12:07:00.000Z"),
        decidedByUserId: USER_ID,
      }),
    ).toBeNull();
  });

  it("reserves one iteration winner and restores only the owning run", () => {
    const metadata = withOutputProposal(
      { lineDelta: { added: 3, removed: 1 } },
      {
        runId: RUN_ID,
        triggerType: "scheduled",
        createdAt: CREATED_AT.toISOString(),
      },
    );
    const reserved = reserveOutputProposalIterationMetadata({
      metadata,
      reservation: {
        runId: "iteration-run",
        feedbackMessageId: "feedback-message",
        requestedAt: "2026-07-23T12:10:00.000Z",
        requestedByUserId: USER_ID,
      },
    });

    expect(outputProposalFromMetadata(reserved)).toMatchObject({
      status: "iterating",
      iteration: {
        runId: "iteration-run",
        feedbackMessageId: "feedback-message",
      },
    });
    expect(
      reserveOutputProposalIterationMetadata({
        metadata: reserved,
        reservation: {
          runId: "second-run",
          feedbackMessageId: "second-message",
          requestedAt: "2026-07-23T12:11:00.000Z",
          requestedByUserId: USER_ID,
        },
      }),
    ).toBeNull();
    expect(
      releaseOutputProposalIterationMetadata({
        metadata: reserved,
        runId: "not-the-owner",
      }),
    ).toBeNull();

    const released = releaseOutputProposalIterationMetadata({
      metadata: reserved,
      runId: "iteration-run",
    });
    expect(released).toMatchObject({
      lineDelta: { added: 3, removed: 1 },
      outputProposal: { status: "proposed" },
    });
    expect(outputProposalFromMetadata(released)?.iteration).toBeUndefined();
  });

  it("preserves iteration lineage while superseding the source proposal", () => {
    const replacementLineage = {
      sourceArtifactId: "artifact-source",
      sourceRunId: RUN_ID,
      feedbackMessageId: "feedback-message",
      requestedAt: "2026-07-23T12:10:00.000Z",
      requestedByUserId: USER_ID,
    };
    const metadata = reserveOutputProposalIterationMetadata({
      metadata: withOutputProposal(
        {},
        {
          runId: RUN_ID,
          triggerType: "github_event",
          createdAt: CREATED_AT.toISOString(),
          iterationOf: replacementLineage,
        },
      ),
      reservation: {
        runId: "iteration-run",
        feedbackMessageId: "feedback-message-2",
        requestedAt: "2026-07-23T12:15:00.000Z",
        requestedByUserId: USER_ID,
      },
    });

    const superseded = supersedeOutputProposalMetadata({
      metadata,
      runId: "iteration-run",
      replacementArtifactId: "artifact-replacement",
      decidedAt: new Date("2026-07-23T12:16:00.000Z"),
      decidedByUserId: USER_ID,
    });

    expect(outputProposalFromMetadata(superseded)).toMatchObject({
      status: "superseded",
      replacedByArtifactId: "artifact-replacement",
      iterationOf: replacementLineage,
      iteration: { runId: "iteration-run" },
    });
  });
});
