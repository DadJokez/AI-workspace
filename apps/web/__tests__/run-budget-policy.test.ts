import { RUN_BUDGET_RECEIPT_SCHEMA } from "@ai-workspace/agent";
import { describe, expect, it } from "vitest";

import {
  RUN_BUDGET_DEFAULTS,
  resolveNewRunBudget,
  resolveRetryRunBudget,
  resolveStoredRunBudget,
} from "@/lib/run-budget-policy";

describe("run budget policy", () => {
  it("resolves immutable defaults by lane and unattended trigger", () => {
    expect(
      resolveNewRunBudget({ lane: "tool-local", triggerType: "chat" }).envelope
        .limits,
    ).toEqual(RUN_BUDGET_DEFAULTS["tool-local"]);
    expect(
      resolveNewRunBudget({ lane: "durable-local", triggerType: "scheduled" })
        .envelope.limits,
    ).toEqual(RUN_BUDGET_DEFAULTS.scheduled);
    expect(
      resolveNewRunBudget({ lane: "durable-local", triggerType: "github_event" })
        .envelope.limits,
    ).toEqual(RUN_BUDGET_DEFAULTS.event);
  });

  it("cannot be loosened through client-shaped input", () => {
    const untrustedRequest = {
      lane: "tool-local",
      triggerType: "chat",
      budget: { limits: { tokens: Number.MAX_SAFE_INTEGER } },
    } as const;
    const resolved = resolveNewRunBudget(untrustedRequest);
    expect(resolved.envelope.limits).toEqual(RUN_BUDGET_DEFAULTS["tool-local"]);
  });

  it("preserves the source envelope but resets retry consumption", () => {
    const source = {
      ...resolveNewRunBudget({ lane: "durable-local", triggerType: "chat" }),
      consumed: {
        tokens: 50_000,
        usd: 0.5,
        wallClockMs: 1_000,
        toolIterations: 2,
      },
    };
    const retry = resolveRetryRunBudget({
      source,
      lane: "durable-local",
      triggerType: "chat_retry",
    });
    expect(retry.envelope).toEqual(source.envelope);
    expect(retry).not.toHaveProperty("consumed");
  });

  it("carries matching receipt consumption across approval resume", () => {
    const stored = resolveNewRunBudget({
      lane: "durable-local",
      triggerType: "chat",
    });
    const consumed = {
      tokens: 25_000,
      usd: 0.2,
      wallClockMs: 3_000,
      toolIterations: 1,
    };
    const resumed = resolveStoredRunBudget({
      stored,
      priorReceipt: {
        schema: RUN_BUDGET_RECEIPT_SCHEMA,
        version: 1,
        governingLayer: stored.envelope.governingLayer,
        limits: stored.envelope.limits,
        consumed,
        partial: false,
      },
      lane: "durable-local",
      triggerType: "chat",
    });
    expect(resumed.consumed).toEqual(consumed);
  });

  it("rejects a mismatched receipt instead of loosening stored policy", () => {
    const stored = resolveNewRunBudget({
      lane: "tool-local",
      triggerType: "chat",
    });
    const resumed = resolveStoredRunBudget({
      stored,
      priorReceipt: {
        schema: RUN_BUDGET_RECEIPT_SCHEMA,
        version: 1,
        governingLayer: stored.envelope.governingLayer,
        limits: { ...stored.envelope.limits, tokens: 9_999_999 },
        consumed: {
          tokens: 1,
          usd: 0,
          wallClockMs: 0,
          toolIterations: 0,
        },
        partial: false,
      },
      lane: "tool-local",
      triggerType: "chat",
    });
    expect(resumed).toEqual({ envelope: stored.envelope });
  });
});
