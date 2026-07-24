import { describe, expect, it } from "vitest";
import {
  isTerminalRunStatus,
  liveTokenTotalFromRunOutput,
  shouldReloadThread,
  type RunStatusSnapshot,
} from "@/lib/run-poll";

/**
 * #447: the pending-run poll must reload the full thread only when the run
 * moved — cursor advance or terminal status — never on an idle tick.
 */

const running = (sequence: number | null): RunStatusSnapshot => ({
  status: "running",
  latestEventSequence: sequence,
});

describe("isTerminalRunStatus", () => {
  it("treats queued and running as in-flight", () => {
    expect(isTerminalRunStatus("queued")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
  });

  it("treats everything else as terminal", () => {
    expect(isTerminalRunStatus("succeeded")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("canceled")).toBe(true);
  });
});

describe("liveTokenTotalFromRunOutput", () => {
  it("reads canonical usage and legacy top-level counters", () => {
    expect(
      liveTokenTotalFromRunOutput({
        usage: { tokensIn: 8_000, tokensOut: 400 },
      }),
    ).toBe(8_400);
    expect(
      liveTokenTotalFromRunOutput({ tokensIn: 12, tokensOut: 3 }),
    ).toBe(15);
  });

  it("fails closed for malformed or negative counters", () => {
    expect(liveTokenTotalFromRunOutput(null)).toBeNull();
    expect(
      liveTokenTotalFromRunOutput({
        usage: { tokensIn: "8000", tokensOut: -2 },
      }),
    ).toBeNull();
    expect(
      liveTokenTotalFromRunOutput({
        usage: { tokensIn: 11 },
        tokensOut: 7,
      }),
    ).toBe(18);
  });
});

describe("shouldReloadThread", () => {
  it("does not reload on an idle tick — the whole point of #447", () => {
    expect(shouldReloadThread(running(3), running(3))).toBe(false);
    expect(shouldReloadThread(running(null), running(null))).toBe(false);
  });

  it("reloads on the first slim tick to seed the cursor", () => {
    expect(shouldReloadThread(null, running(3))).toBe(true);
  });

  it("reloads when the event cursor advances", () => {
    expect(shouldReloadThread(running(3), running(4))).toBe(true);
    expect(shouldReloadThread(running(null), running(1))).toBe(true);
  });

  it("reloads on a status transition", () => {
    expect(
      shouldReloadThread(
        { status: "queued", latestEventSequence: null },
        running(null),
      ),
    ).toBe(true);
  });

  it("always reloads on a terminal status, even with an unchanged cursor", () => {
    for (const status of ["succeeded", "failed", "canceled"]) {
      expect(
        shouldReloadThread(running(3), { status, latestEventSequence: 3 }),
      ).toBe(true);
    }
  });
});
