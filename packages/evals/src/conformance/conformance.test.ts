import { describe, expect, it } from "vitest";
import {
  CONFORMANCE_PROBE_IDS,
  type ConformanceDeclarations,
  type ConformanceLaneProvenance,
  type ConformanceProbeEvidenceById,
  type ConformanceProbeExecution,
  type ConformanceProbeId,
  type RuntimeConformanceDriver,
} from "./types";
import {
  OfflineContractDriver,
  PASSING_PROBE_EVIDENCE,
  createCurrentDeclarations,
} from "./fixtures";
import { validateConformanceProbe } from "./probes";
import {
  renderConformanceJson,
  renderConformanceMarkdown,
} from "./report";
import { runRuntimeConformance, sanitizeText } from "./runner";

const provenance: ConformanceLaneProvenance = {
  lane: "tool-local",
  runtime: "bedrock",
  modelId: "sonnet-4-5",
  mode: "offline-contract",
  appVersion: "0.1.0",
  commitSha: "abc123",
  runtimeImage: "sha256:fixture",
  environment: "test",
};

const FAILING_PROBE_EVIDENCE: {
  [K in ConformanceProbeId]: ConformanceProbeEvidenceById[K];
} = {
  "basic-turn": {
    completed: false,
    assistantOutputPresent: false,
    persistedAssistantOutputs: 0,
    terminalState: "running",
  },
  streaming: { textDeltaCount: 1, firstTokenMs: null, completed: false },
  "text-input": { accepted: false, contentObserved: false },
  "image-input": { accepted: false, contentObserved: false },
  "business-file-input": { classes: {} },
  "tool-loop": {
    toolCallCount: 0,
    toolResultCount: 0,
    assistantContinuedAfterResult: false,
  },
  "policy-enforcement": {
    allowedActionExecuted: false,
    approvalRequiredActionPaused: false,
    blockedActionPrevented: false,
    unauthorizedSideEffects: 1,
  },
  cancellation: {
    cancellationAccepted: true,
    terminalState: "canceled",
    postCancelAssistantOutputs: 1,
    postCancelArtifacts: 1,
    postCancelToolSideEffects: 1,
  },
  resume: {
    disconnected: true,
    resumed: false,
    duplicateEventCount: 1,
    terminalState: "running",
  },
  "stream-recovery": {
    malformedStreamHandled: false,
    interruptedStreamHandled: false,
    terminalStateRecorded: false,
  },
  "artifact-integrity": {
    artifactCreated: false,
    attachmentLinked: false,
    contentHashMatches: false,
  },
  "usage-reporting": {
    usageEventPresent: false,
    tokensIn: -1,
    tokensOut: 0,
    costUsd: -1,
  },
  "queued-next-turn": {
    accepted: false,
    deliveredExactlyOnce: false,
    orderPreserved: false,
  },
  "live-steering": {
    accepted: false,
    affectedCurrentTurn: false,
    persistedAsUserGuidance: false,
  },
  "context-management": {
    stayedWithinBudget: false,
    strategy: "none",
    receiptPresent: false,
  },
  "child-runs": {
    childEventsLinked: false,
    terminalStatesRecorded: false,
    aggregateUsageReported: false,
  },
  "sandbox-browser-console": {
    browserAvailable: false,
    consoleAvailable: false,
    isolated: false,
    egressPolicyEnforced: false,
  },
};

class FakeRuntimeDriver implements RuntimeConformanceDriver {
  readonly provenance: ConformanceLaneProvenance;
  readonly declarations: ConformanceDeclarations;
  readonly calls: ConformanceProbeId[] = [];
  private readonly overrides: Partial<
    Record<ConformanceProbeId, ConformanceProbeExecution<ConformanceProbeId>>
  >;

  constructor({
    declarations = createCurrentDeclarations(),
    overrides = {},
    mode = "offline-contract",
  }: {
    declarations?: ConformanceDeclarations;
    overrides?: Partial<
      Record<ConformanceProbeId, ConformanceProbeExecution<ConformanceProbeId>>
    >;
    mode?: ConformanceLaneProvenance["mode"];
  } = {}) {
    this.provenance = { ...provenance, mode };
    this.declarations = declarations;
    this.overrides = overrides;
  }

  async runProbe<K extends ConformanceProbeId>(
    probeId: K,
  ): Promise<ConformanceProbeExecution<K>> {
    this.calls.push(probeId);
    return (this.overrides[probeId] ?? {
      outcome: "observed",
      evidence: PASSING_PROBE_EVIDENCE[probeId],
      costUsd: 0,
    }) as ConformanceProbeExecution<K>;
  }
}

describe("runtime conformance probes", () => {
  it("validates good and bad evidence for every probe", () => {
    for (const probeId of CONFORMANCE_PROBE_IDS) {
      expect(
        validateConformanceProbe(probeId, PASSING_PROBE_EVIDENCE[probeId]),
        `${probeId} should accept passing evidence`,
      ).toMatchObject({ status: "passed" });
      expect(
        validateConformanceProbe(probeId, FAILING_PROBE_EVIDENCE[probeId]),
        `${probeId} should reject failing evidence`,
      ).not.toMatchObject({ status: "passed" });
    }
  });

  it("requires complete coverage of every advertised business-file class", () => {
    const evidence = structuredClone(
      PASSING_PROBE_EVIDENCE["business-file-input"],
    );
    delete evidence.classes.image;

    expect(validateConformanceProbe("business-file-input", evidence)).toEqual({
      status: "partial",
      summary: "Missing complete coverage for: image.",
      evidence: {
        advertisedClasses: 5,
        coveredClasses: 4,
        missingClasses: "image",
      },
    });
  });

  it("fails cancellation when any work persists afterward", () => {
    const validation = validateConformanceProbe(
      "cancellation",
      FAILING_PROBE_EVIDENCE.cancellation,
    );
    expect(validation.status).toBe("failed");
    expect(validation.evidence).toMatchObject({
      postCancelAssistantOutputs: 1,
      postCancelArtifacts: 1,
      postCancelToolSideEffects: 1,
    });
  });
});

describe("runtime conformance reconciliation", () => {
  it("passes the offline contract without claiming production eligibility", async () => {
    const driver = new OfflineContractDriver({ provenance });
    const report = await runRuntimeConformance(driver, {
      now: () => new Date("2026-08-10T12:00:00.000Z"),
      reportId: "report-1",
      maxCostUsd: 0,
    });

    expect(report.schema).toBe("runtime-conformance.v1");
    expect(report.results).toHaveLength(CONFORMANCE_PROBE_IDS.length);
    expect(report.counts).toMatchObject({
      SUPPORTED: 14,
      UNSUPPORTED: 3,
      DRIFT: 0,
      SKIPPED: 0,
    });
    expect(report.gate).toMatchObject({
      contractPassed: true,
      eligibleForProduction: false,
      blockingProbeIds: [],
      inconclusiveProbeIds: [],
    });
  });

  it("turns an intentional false support declaration into blocking DRIFT", async () => {
    const driver = new FakeRuntimeDriver({
      overrides: {
        streaming: {
          outcome: "observed",
          evidence: FAILING_PROBE_EVIDENCE.streaming,
        },
      },
    });
    const report = await runRuntimeConformance(driver);
    const result = report.results.find((candidate) => candidate.id === "streaming");

    expect(result).toMatchObject({ verdict: "DRIFT", gateImpact: "block" });
    expect(report.gate.contractPassed).toBe(false);
    expect(report.gate.blockingProbeIds).toContain("streaming");
  });

  it("preserves missing credentials as SKIPPED rather than unsupported", async () => {
    const driver = new FakeRuntimeDriver({
      overrides: {
        "image-input": {
          outcome: "skipped",
          category: "credentials",
          summary: "Image fixture credential is unavailable.",
        },
      },
    });
    const report = await runRuntimeConformance(driver);
    const result = report.results.find(
      (candidate) => candidate.id === "image-input",
    );

    expect(result).toMatchObject({
      verdict: "SKIPPED",
      category: "credentials",
      gateImpact: "inconclusive",
    });
    expect(report.counts.UNSUPPORTED).toBe(3);
    expect(report.gate.inconclusiveProbeIds).toContain("image-input");
  });

  it("keeps product and provider failures distinct", async () => {
    const driver = new FakeRuntimeDriver({
      overrides: {
        "basic-turn": {
          outcome: "failed",
          category: "product",
          summary: "Persistence failed.",
        },
        streaming: {
          outcome: "failed",
          category: "provider",
          summary: "Provider stream failed.",
        },
      },
    });
    const report = await runRuntimeConformance(driver);

    expect(report.results.find((result) => result.id === "basic-turn")).toMatchObject({
      verdict: "DRIFT",
      category: "product",
    });
    expect(report.results.find((result) => result.id === "streaming")).toMatchObject({
      verdict: "DRIFT",
      category: "provider",
    });
  });

  it("accepts a truthful partial declaration but blocks partial required support", async () => {
    const declarations = createCurrentDeclarations();
    declarations["live-steering"] = {
      status: "partial",
      source: "fixture declaration",
    };
    const driver = new FakeRuntimeDriver({
      declarations,
      overrides: {
        "live-steering": {
          outcome: "observed",
          evidence: {
            accepted: true,
            affectedCurrentTurn: false,
            persistedAsUserGuidance: true,
          },
        },
      },
    });
    const report = await runRuntimeConformance(driver);

    expect(
      report.results.find((result) => result.id === "live-steering"),
    ).toMatchObject({ verdict: "PARTIAL", gateImpact: "pass" });
  });

  it("skips later probes explicitly when the probe budget is exhausted", async () => {
    const driver = new FakeRuntimeDriver();
    const report = await runRuntimeConformance(driver, { maxProbes: 1 });

    expect(driver.calls).toEqual(["basic-turn"]);
    expect(report.budget).toMatchObject({ executedProbes: 1, exhausted: true });
    expect(report.results.find((result) => result.id === "streaming")).toMatchObject({
      verdict: "SKIPPED",
      category: "quota",
    });
  });

  it("allows a passing live report to qualify but never an offline fixture", async () => {
    const live = await runRuntimeConformance(
      new FakeRuntimeDriver({ mode: "pre-enable" }),
    );
    const offline = await runRuntimeConformance(new FakeRuntimeDriver());

    expect(live.gate.eligibleForProduction).toBe(true);
    expect(offline.gate.eligibleForProduction).toBe(false);
  });
});

describe("runtime conformance reports", () => {
  it("renders machine-readable JSON and a concise Markdown capability matrix", async () => {
    const report = await runRuntimeConformance(
      new OfflineContractDriver({ provenance }),
      {
        now: () => new Date("2026-08-10T12:00:00.000Z"),
        reportId: "report-1",
        maxCostUsd: 0,
      },
    );
    const json = renderConformanceJson(report);
    const markdown = renderConformanceMarkdown(report);

    expect(JSON.parse(json)).toMatchObject({
      schema: "runtime-conformance.v1",
      reportId: "report-1",
      provenance: { lane: "tool-local", runtime: "bedrock" },
    });
    expect(markdown).toContain("| Probe | Requirement | Declared | Verdict |");
    expect(markdown).toContain("not eligible from offline evidence alone");
    expect(markdown).toContain("**SUPPORTED**");
  });

  it("redacts credential-shaped text before it reaches retained evidence", () => {
    const raw =
      "Bearer abc123 token=super-secret password:open-sesame https://x.test?a=1&key=value";
    expect(sanitizeText(raw)).toBe(
      "Bearer [REDACTED] token=[REDACTED] password:[REDACTED] https://x.test?a=1&key=[REDACTED]",
    );
  });
});
