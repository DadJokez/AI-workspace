import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, ModelId } from "@ai-workspace/agent";
import type { AgentRuntime } from "@ai-workspace/agent-runtime";
import {
  isModelFailoverEligibleError,
  runTurnWithModelFailover,
} from "@/lib/model-failover";

const candidates: ModelId[] = ["sonnet-4-6", "haiku-4-5"];

async function collect(
  runtime: AgentRuntime,
  onFailover = vi.fn(),
): Promise<{ events: AgentEvent[]; onFailover: typeof onFailover }> {
  const events: AgentEvent[] = [];
  for await (const event of runTurnWithModelFailover({
    runtime,
    candidates,
    onFailover,
    input: {
      threadId: "thread-1",
      modelId: candidates[0]!,
      messages: [{ role: "user", content: "hello" }],
      context: { userId: "user-1" },
    },
  })) {
    events.push(event);
  }
  return { events, onFailover };
}

describe("runTurnWithModelFailover", () => {
  it("retries the next candidate on a pre-output throttle", async () => {
    const attempted: string[] = [];
    const runtime = {
      name: "bedrock",
      runTurn: async function* ({ modelId }: { modelId: string }) {
        attempted.push(modelId);
        if (modelId === "sonnet-4-6") {
          yield {
            type: "error",
            message: "ThrottlingException: too many requests",
          } satisfies AgentEvent;
          return;
        }
        yield { type: "text-delta", delta: "Hello" } satisfies AgentEvent;
        yield { type: "done" } satisfies AgentEvent;
      },
    } as unknown as AgentRuntime;

    const result = await collect(runtime);

    expect(attempted).toEqual(["sonnet-4-6", "haiku-4-5"]);
    expect(result.events).toEqual([
      { type: "text-delta", delta: "Hello" },
      { type: "done" },
    ]);
    expect(result.onFailover).toHaveBeenCalledWith({
      fromModelId: "sonnet-4-6",
      toModelId: "haiku-4-5",
      error: "ThrottlingException: too many requests",
      attempt: 1,
    });
  });

  it("retries when model access fails by throwing before output", async () => {
    const runtime = {
      name: "bedrock",
      runTurn: async function* ({ modelId }: { modelId: string }) {
        if (modelId === "sonnet-4-6") {
          throw new Error("Model access is denied for this model");
        }
        yield { type: "done" } satisfies AgentEvent;
      },
    } as unknown as AgentRuntime;

    const result = await collect(runtime);

    expect(result.events).toEqual([{ type: "done" }]);
    expect(result.onFailover).toHaveBeenCalledOnce();
  });

  it("may switch after diagnostic request metadata but before semantic output", async () => {
    const runtime = {
      name: "bedrock",
      runTurn: async function* ({ modelId }: { modelId: string }) {
        if (modelId === "sonnet-4-6") {
          yield {
            type: "provider-request",
            iteration: 0,
            request: {
              providerModelId: "provider-sonnet",
              messages: [],
              tools: [],
            },
          } satisfies AgentEvent;
          yield {
            type: "error",
            message: "ServiceUnavailableException",
          } satisfies AgentEvent;
          return;
        }
        yield { type: "done" } satisfies AgentEvent;
      },
    } as unknown as AgentRuntime;

    const result = await collect(runtime);

    expect(result.events.map((event) => event.type)).toEqual([
      "provider-request",
      "done",
    ]);
    expect(result.onFailover).toHaveBeenCalledOnce();
  });

  it("does not replay after visible output has committed the attempt", async () => {
    const runtime = {
      name: "bedrock",
      runTurn: async function* () {
        yield { type: "text-delta", delta: "Partial" } satisfies AgentEvent;
        yield {
          type: "error",
          message: "ThrottlingException",
        } satisfies AgentEvent;
      },
    } as unknown as AgentRuntime;

    const result = await collect(runtime);

    expect(result.events).toEqual([
      { type: "text-delta", delta: "Partial" },
      { type: "error", message: "ThrottlingException" },
    ]);
    expect(result.onFailover).not.toHaveBeenCalled();
  });

  it("does not switch models for an unrelated tool failure", async () => {
    const runtime = {
      name: "bedrock",
      runTurn: async function* () {
        yield {
          type: "error",
          message: "MCP connection failed for github",
        } satisfies AgentEvent;
      },
    } as unknown as AgentRuntime;

    const result = await collect(runtime);

    expect(result.events).toEqual([
      { type: "error", message: "MCP connection failed for github" },
    ]);
    expect(result.onFailover).not.toHaveBeenCalled();
  });

  it("keeps single-candidate behavior unchanged", async () => {
    const onFailover = vi.fn();
    const events: AgentEvent[] = [];
    const runtime = {
      name: "bedrock",
      runTurn: async function* () {
        yield {
          type: "error",
          message: "ThrottlingException",
        } satisfies AgentEvent;
      },
    } as unknown as AgentRuntime;

    for await (const event of runTurnWithModelFailover({
      runtime,
      candidates: ["sonnet-4-6"],
      onFailover,
      input: {
        threadId: "thread-1",
        modelId: "sonnet-4-6",
        messages: [],
        context: { userId: "user-1" },
      },
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "error", message: "ThrottlingException" },
    ]);
    expect(onFailover).not.toHaveBeenCalled();
  });

  it("does not reinterpret failover bookkeeping errors as provider errors", async () => {
    const runtime = {
      name: "bedrock",
      runTurn: async function* () {
        yield {
          type: "error",
          message: "ThrottlingException",
        } satisfies AgentEvent;
      },
    } as unknown as AgentRuntime;
    const onFailover = vi
      .fn()
      .mockRejectedValue(new Error("audit service unavailable"));

    await expect(collect(runtime, onFailover)).rejects.toThrow(
      "audit service unavailable",
    );
    expect(onFailover).toHaveBeenCalledOnce();
  });
});

describe("isModelFailoverEligibleError", () => {
  it("accepts bounded model availability failures", () => {
    expect(isModelFailoverEligibleError("ThrottlingException")).toBe(true);
    expect(isModelFailoverEligibleError("HTTP 429")).toBe(true);
    expect(isModelFailoverEligibleError("ModelNotReadyException")).toBe(true);
    expect(isModelFailoverEligibleError("unknown model id")).toBe(true);
  });

  it("does not mask AgentCore IAM or generic tool errors", () => {
    expect(
      isModelFailoverEligibleError(
        "AccessDeniedException: not authorized for bedrock-agentcore",
      ),
    ).toBe(false);
    expect(isModelFailoverEligibleError("GitHub MCP connection failed")).toBe(
      false,
    );
  });
});
