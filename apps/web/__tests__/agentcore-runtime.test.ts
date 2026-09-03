import { describe, expect, it } from "vitest";
import {
  RUN_BUDGET_SCHEMA,
  type AgentEvent,
} from "@ai-workspace/agent";
import {
  AgentCoreRuntime,
  parseAgentEventSse,
  toRuntimeSessionId,
} from "@ai-workspace/agent-runtime";

function bytes(...parts: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return (async function* () {
    for (const part of parts) yield encoder.encode(part);
  })();
}

async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe("toRuntimeSessionId", () => {
  it("passes thread UUIDs through (36 chars ≥ the 33 minimum)", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(toRuntimeSessionId(uuid)).toBe(uuid);
  });

  it("pads short ids deterministically to 33 chars", () => {
    const id = toRuntimeSessionId("thread-1");
    expect(id.length).toBeGreaterThanOrEqual(33);
    expect(id).toBe(toRuntimeSessionId("thread-1"));
    expect(id.startsWith("thread-1-")).toBe(true);
  });
});

describe("parseAgentEventSse", () => {
  it("parses events split across arbitrary chunk boundaries", async () => {
    const events = await collect(
      parseAgentEventSse(
        bytes(
          'data: {"type":"text-de',
          'lta","delta":"hel"}\n\ndata: {"type":"text-delta","delta":"lo"}\n\n',
          ': heartbeat comment\n\n',
          'data: {"type":"usage","tokensIn":3,"tokensOut":4}\n\ndata: {"type":"done"}\n\n',
        ),
      ),
    );
    expect(events).toEqual([
      { type: "text-delta", delta: "hel" },
      { type: "text-delta", delta: "lo" },
      { type: "usage", tokensIn: 3, tokensOut: 4 },
      { type: "done" },
    ]);
  });

  it("relays provider reasoning and response metadata events", async () => {
    const events = await collect(
      parseAgentEventSse(
        bytes(
          'data: {"type":"provider-reasoning-delta","iteration":0,"blockIndex":0,"delta":"Check the repository."}\n\n',
          'data: {"type":"provider-response-metadata","iteration":0,"stopReason":"end_turn","latencyMs":321}\n\n',
        ),
      ),
    );

    expect(events).toEqual([
      {
        type: "provider-reasoning-delta",
        iteration: 0,
        blockIndex: 0,
        delta: "Check the repository.",
      },
      {
        type: "provider-response-metadata",
        iteration: 0,
        stopReason: "end_turn",
        latencyMs: 321,
      },
    ]);
  });

  it("ignores unknown event shapes and junk lines", async () => {
    const events = await collect(
      parseAgentEventSse(
        bytes('data: {"type":"mystery"}\n\nnot-sse-at-all\n\ndata: {"type":"done"}\n\n'),
      ),
    );
    expect(events).toEqual([{ type: "done" }]);
  });
});

describe("AgentCoreRuntime", () => {
  const baseInput = {
    threadId: "123e4567-e89b-12d3-a456-426614174000",
    modelId: "sonnet-4-6",
    messages: [{ role: "user" as const, content: "hi" }],
    context: { userId: "u1" },
  };

  it("invokes the runtime and relays the SSE event stream", async () => {
    let captured: Record<string, unknown> | null = null;
    const runtime = new AgentCoreRuntime({
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:1:runtime/spike",
      client: {
        send: async (command: { input: Record<string, unknown> }) => {
          captured = command.input;
          return {
            contentType: "text/event-stream",
            response: bytes(
              'data: {"type":"text-delta","delta":"hi"}\n\ndata: {"type":"budget","receipt":{"schema":"comparative.run-budget-receipt.v1","version":1,"governingLayer":"organization","limits":{"tokens":100000,"usd":1,"wallClockMs":120000,"toolIterations":8},"consumed":{"tokens":10,"usd":0.001,"wallClockMs":50,"toolIterations":0},"partial":false}}\n\ndata: {"type":"done"}\n\n',
            ),
          };
        },
      } as never,
    });

    const events = await collect(
      runtime.runTurn({
        ...baseInput,
        requiredToolName: "google__create_event",
        mcpServers: {
          github: {
            type: "http",
            url: "https://mcp.example.test/github",
            toolPolicies: { list_pull_requests: "always_allow" },
            defaultToolPolicy: "needs_approval",
          },
        },
        userTimeZone: "America/New_York",
        webEgressPolicy: {
          name: "admin_domain_denylist",
          deniedDomains: ["blocked.example"],
        },
        toolApprovalGrants: [
          {
            schema: "comparative.tool-approval-grant.v1",
            approvalId: "approval-1",
            fingerprint: "a".repeat(64),
            decision: "approved",
            consumed: true,
            replayOutput: { drafted: true },
          },
        ],
        toolApprovalMode: "deny_unattended",
        budget: {
          envelope: {
            schema: RUN_BUDGET_SCHEMA,
            version: 1,
            governingLayer: "organization",
            limits: {
              tokens: 100_000,
              usd: 1,
              wallClockMs: 120_000,
              toolIterations: 8,
            },
          },
        },
      }),
    );
    expect(events).toEqual([
      { type: "text-delta", delta: "hi" },
      {
        type: "budget",
        receipt: {
          schema: "comparative.run-budget-receipt.v1",
          version: 1,
          governingLayer: "organization",
          limits: {
            tokens: 100_000,
            usd: 1,
            wallClockMs: 120_000,
            toolIterations: 8,
          },
          consumed: {
            tokens: 10,
            usd: 0.001,
            wallClockMs: 50,
            toolIterations: 0,
          },
          partial: false,
        },
      },
      { type: "done" },
    ]);

    expect(captured).not.toBeNull();
    const input = captured! as {
      agentRuntimeArn: string;
      runtimeSessionId: string;
      runtimeUserId: string;
      payload: Uint8Array;
    };
    expect(input.agentRuntimeArn).toContain("runtime/spike");
    expect(input.runtimeSessionId).toBe(baseInput.threadId);
    expect(input.runtimeUserId).toBe("u1");
    const payload = JSON.parse(new TextDecoder().decode(input.payload));
    expect(payload.modelId).toBe("sonnet-4-6");
    expect(payload.userId).toBe("u1");
    expect(payload.requiredToolName).toBe("google__create_event");
    expect(payload.mcpServers.github).toMatchObject({
      url: "https://mcp.example.test/github",
      toolPolicies: { list_pull_requests: "always_allow" },
      defaultToolPolicy: "needs_approval",
    });
    expect(payload.webEgressPolicy).toEqual({
      name: "admin_domain_denylist",
      deniedDomains: ["blocked.example"],
    });
    // #432: the clock context rides the payload into the container.
    expect(payload.userTimeZone).toBe("America/New_York");
    expect(payload.toolApprovalGrants).toEqual([
      {
        schema: "comparative.tool-approval-grant.v1",
        approvalId: "approval-1",
        fingerprint: "a".repeat(64),
        decision: "approved",
        consumed: true,
        replayOutput: { drafted: true },
      },
    ]);
    expect(payload.toolApprovalMode).toBe("deny_unattended");
    expect(payload.budget).toEqual({
      envelope: {
        schema: RUN_BUDGET_SCHEMA,
        version: 1,
        governingLayer: "organization",
        limits: {
          tokens: 100_000,
          usd: 1,
          wallClockMs: 120_000,
          toolIterations: 8,
        },
      },
    });
  });

  it("yields an error event when the invoke call throws", async () => {
    const runtime = new AgentCoreRuntime({
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:1:runtime/spike",
      client: {
        send: async () => {
          throw new Error("AccessDeniedException: nope");
        },
      } as never,
    });

    const events = await collect(runtime.runTurn(baseInput));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { message: string }).message).toContain(
      "AccessDeniedException",
    );
  });

  it("handles a JSON error envelope on non-streaming responses", async () => {
    const runtime = new AgentCoreRuntime({
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:1:runtime/spike",
      client: {
        send: async () => ({
          contentType: "application/json",
          response: bytes('{"error":"Unknown or missing modelId"}'),
        }),
      } as never,
    });

    const events = await collect(runtime.runTurn(baseInput));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { message: string }).message).toContain("modelId");
  });
});
