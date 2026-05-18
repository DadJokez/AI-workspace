import { describe, expect, it } from "vitest";
import {
  buildWorkflowRunInputs,
  canRetryWorkflowRun,
} from "@/lib/workflow-retry";

describe("workflow retry helpers", () => {
  it("allows retry only for terminal failed states", () => {
    expect(canRetryWorkflowRun("failed")).toBe(true);
    expect(canRetryWorkflowRun("canceled")).toBe(true);
    expect(canRetryWorkflowRun("succeeded")).toBe(false);
    expect(canRetryWorkflowRun("running")).toBe(false);
    expect(canRetryWorkflowRun("queued")).toBe(false);
  });

  it("records retry source metadata in new run inputs", () => {
    expect(
      buildWorkflowRunInputs({
        prompt: "Run briefing",
        retryRequestedAt: new Date("2026-05-18T02:00:00.000Z"),
        retrySource: {
          id: "run_123",
          status: "failed",
          error: "github_not_connected",
        },
      }),
    ).toEqual({
      prompt: "Run briefing",
      retryOfRunId: "run_123",
      retryOfStatus: "failed",
      retryOfError: "github_not_connected",
      retryRequestedAt: "2026-05-18T02:00:00.000Z",
    });
  });
});
