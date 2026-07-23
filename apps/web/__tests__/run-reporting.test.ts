import { describe, expect, it } from "vitest";
import {
  buildRuntimeV2Report,
  type RuntimeReportRow,
} from "@/lib/admin/run-reporting";

describe("runtime v2 reporting", () => {
  it("computes p50/p95 first-token latency by runtime lane", () => {
    const rows: RuntimeReportRow[] = [
      ...Array.from({ length: 25 }, (_, index) =>
        runRow({
          id: `fast-${index + 1}`,
          lane: "fast-local",
          firstTokenMs: (index + 1) * 100,
        }),
      ),
      runRow({
        id: "tool-1",
        lane: "tool-local",
        runtimeTarget: "bedrock-agent",
        firstTokenMs: 3200,
      }),
      runRow({
        id: "durable-1",
        lane: "durable-local",
        runtimeTarget: "agentcore-worker",
        firstTokenMs: 6100,
      }),
      runRow({
        id: "cloud-1",
        lane: "cursor-cloud",
        executionMode: "cloud",
        runtimeTarget: "cursor-cloud",
        firstTokenMs: 8800,
      }),
    ];

    const report = buildRuntimeV2Report(rows);

    expect(report.fastLocalSampleCount).toBe(25);
    expect(report.laneLatency).toContainEqual(
      expect.objectContaining({
        lane: "fast-local",
        runCount: 25,
        firstTokenSamples: 25,
        p50FirstTokenMs: 1300,
        p95FirstTokenMs: 2400,
      }),
    );
    expect(report.laneLatency).toContainEqual(
      expect.objectContaining({
        lane: "tool-local",
        p50FirstTokenMs: 3200,
        p95FirstTokenMs: 3200,
      }),
    );
    expect(report.laneLatency).toContainEqual(
      expect.objectContaining({
        lane: "cursor-cloud",
        p50FirstTokenMs: 8800,
      }),
    );
  });

  it("groups failed runs by lane, target, provider, model, and error class", () => {
    const rows: RuntimeReportRow[] = [
      runRow({
        id: "failed-1",
        status: "failed",
        lane: "tool-local",
        runtimeTarget: "bedrock-agent",
        provider: "bedrock",
        modelId: "sonnet-4-6",
        errorClass: "model_access",
      }),
      runRow({
        id: "failed-2",
        status: "failed",
        lane: "tool-local",
        runtimeTarget: "bedrock-agent",
        provider: "bedrock",
        modelId: "sonnet-4-6",
        errorClass: "model_access",
      }),
      runRow({
        id: "failed-3",
        status: "failed",
        lane: "durable-local",
        runtimeTarget: "agentcore-worker",
        provider: "agentcore",
        modelId: "haiku-4-5",
        error: "worker timed out waiting for first token",
      }),
    ];

    const report = buildRuntimeV2Report(rows);

    expect(report.failureGroups).toEqual([
      {
        lane: "tool-local",
        runtimeTarget: "bedrock-agent",
        provider: "bedrock",
        modelId: "sonnet-4-6",
        errorClass: "model_access",
        count: 2,
      },
      {
        lane: "durable-local",
        runtimeTarget: "agentcore-worker",
        provider: "agentcore",
        modelId: "haiku-4-5",
        errorClass: "timeout",
        count: 1,
      },
    ]);
  });

  it("groups legacy raw AgentCore IAM denials separately from model access", () => {
    const report = buildRuntimeV2Report([
      runRow({
        id: "agentcore-denied",
        status: "failed",
        lane: "durable-local",
        runtimeTarget: "agentcore-worker",
        provider: "agentcore",
        modelId: "sonnet-4-6",
        error:
          "AgentCoreRuntime: invoke failed — AccessDeniedException: not authorized to perform bedrock-agentcore:InvokeAgentRuntimeForUser",
      }),
      runRow({
        id: "model-denied",
        status: "failed",
        lane: "fast-local",
        modelId: "sonnet-4-6",
        error:
          "Model access is denied: not authorized to perform aws-marketplace:Subscribe",
      }),
    ]);

    expect(report.failureGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtimeTarget: "agentcore-worker",
          errorClass: "runtime_authorization_denied",
        }),
        expect.objectContaining({
          runtimeTarget: "direct-chat",
          errorClass: "model_access",
        }),
      ]),
    );
  });
});

function runRow({
  id,
  status = "succeeded",
  lane,
  executionMode = "local",
  runtimeTarget = "direct-chat",
  provider = "bedrock",
  modelId = "haiku-4-5",
  firstTokenMs,
  errorClass,
  error = null,
}: {
  id: string;
  status?: string;
  lane: "fast-local" | "tool-local" | "durable-local" | "cursor-cloud";
  executionMode?: string;
  runtimeTarget?: string;
  provider?: string;
  modelId?: string;
  firstTokenMs?: number;
  errorClass?: string;
  error?: string | null;
}): RuntimeReportRow {
  return {
    id,
    status,
    runtime: provider,
    modelId,
    inputs: {
      executionMode,
      runtimeRoute: { lane, runtimeTarget },
    },
    outputs: {
      runtime: provider,
      runtimeTarget,
      modelId,
      providerRun: { providerAgentId: provider, executionMode },
      metrics:
        typeof firstTokenMs === "number"
          ? { requestToFirstTokenMs: firstTokenMs }
          : {},
      ...(errorClass ? { errorDetails: [{ category: errorClass }] } : {}),
    },
    error,
  };
}
