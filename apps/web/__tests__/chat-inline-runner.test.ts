import { describe, expect, it } from "vitest";
import { buildTimingMetrics } from "@/lib/chat-inline-runner";

describe("buildTimingMetrics", () => {
  it("populates first-token latency once the first token arrives", () => {
    const requestStartedAt = new Date("2026-05-30T12:00:00.000Z");

    const metrics = buildTimingMetrics({
      requestStartedAt,
      inlineStartedAt: new Date("2026-05-30T12:00:00.025Z"),
      contextReadyAt: new Date("2026-05-30T12:00:00.080Z"),
      providerStartedAt: new Date("2026-05-30T12:00:00.100Z"),
      firstTokenAt: new Date("2026-05-30T12:00:00.350Z"),
      completedAt: new Date("2026-05-30T12:00:00.900Z"),
    });

    expect(metrics).toMatchObject({
      requestStartedAt: "2026-05-30T12:00:00.000Z",
      inlineStartedAt: "2026-05-30T12:00:00.025Z",
      firstTokenAt: "2026-05-30T12:00:00.350Z",
      completedAt: "2026-05-30T12:00:00.900Z",
      requestToInlineMs: 25,
      inlineToContextReadyMs: 55,
      requestToProviderMs: 100,
      requestToFirstTokenMs: 350,
      providerToFirstTokenMs: 250,
      requestToCompletedMs: 900,
    });
  });

  it("omits first-token latency before text streams", () => {
    const metrics = buildTimingMetrics({
      requestStartedAt: new Date("2026-05-30T12:00:00.000Z"),
      inlineStartedAt: new Date("2026-05-30T12:00:00.025Z"),
      providerStartedAt: new Date("2026-05-30T12:00:00.100Z"),
    });

    expect(metrics.requestToFirstTokenMs).toBeUndefined();
    expect(metrics.providerToFirstTokenMs).toBeUndefined();
  });
});
