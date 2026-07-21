import { describe, expect, it } from "vitest";
import { buildCapabilityGraph } from "@/lib/capability-graph";
import {
  applyActivatedSkillRoute,
  buildChatRouteReceipt,
  decideChatRuntimeRoute,
  explainChatRuntimeRoute,
  runtimeV2EnabledFromEnv,
} from "@/lib/chat-routing";

describe("decideChatRuntimeRoute", () => {
  it("mounts the stable tool catalog for ordinary turns", () => {
    const currentInfo = decideChatRuntimeRoute({
      message: "who won the england norway game?",
    });
    const chitChat = decideChatRuntimeRoute({
      message: "how are you?",
    });

    for (const route of [currentInfo, chitChat]) {
      expect(route).toMatchObject({
        lane: "tool-local",
        routingMode: "model-decided",
        executionMode: "local",
        runtimeTarget: "bedrock-agent",
        useWorker: false,
        useMcp: true,
        includeVaultContext: true,
        reasons: ["model_decided_tool_catalog"],
      });
    }
  });

  it("keeps durable execution separate from model-decided tool selection", () => {
    expect(
      decideChatRuntimeRoute({
        message: "implement the settings feature in the repo",
      }),
    ).toMatchObject({
      lane: "durable-local",
      routingMode: "model-decided",
      runtimeTarget: "agentcore-worker",
      useWorker: true,
      useMcp: true,
      includeVaultContext: true,
      reasons: ["implementation_work"],
    });
  });

  it("routes explicit background work to the durable local worker", () => {
    expect(
      decideChatRuntimeRoute({
        message: "keep working on this overnight and report back",
      }),
    ).toMatchObject({
      lane: "durable-local",
      runtimeTarget: "agentcore-worker",
      useWorker: true,
      reasons: ["explicit_durable_work"],
    });
  });

  it("treats numbered PR lookup as tool work, not durable PR creation", () => {
    expect(
      decideChatRuntimeRoute({
        message: "open pr #123 and summarize it",
      }),
    ).toMatchObject({
      lane: "tool-local",
      runtimeTarget: "bedrock-agent",
      useWorker: false,
      reasons: ["model_decided_tool_catalog"],
    });
  });

  it("ignores the removed cloud execution mode", () => {
    expect(
      decideChatRuntimeRoute({
        message: "say pong and nothing else",
        executionMode: "cloud",
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "bedrock-agent",
    });
  });

  it("escalates a proceed-style follow-up after durable planning to the worker", () => {
    expect(
      decideChatRuntimeRoute({
        message: "go ahead and do it",
        priorUserMessages: ["Implement the new settings page and run tests"],
      }),
    ).toMatchObject({
      lane: "durable-local",
      runtimeTarget: "agentcore-worker",
      useWorker: true,
      useMcp: true,
      includeVaultContext: true,
      reasons: ["sticky_durable_thread"],
    });
  });

  it("does not escalate a proceed-style follow-up without a durable thread", () => {
    expect(
      decideChatRuntimeRoute({
        message: "go ahead and do it",
        priorUserMessages: ["what's the weather like?"],
      }),
    ).toMatchObject({
      lane: "tool-local",
      useWorker: false,
      reasons: ["model_decided_tool_catalog"],
    });
  });

  it("accepts recommended durable escalation from capability/context signals", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Take this on when you can",
        capabilitySignals: {
          recommendedEscalation: {
            lane: "durable-local",
            reason: "repeated_long_running_repo_work",
          },
        },
      }),
    ).toMatchObject({
      lane: "durable-local",
      runtimeTarget: "agentcore-worker",
      useWorker: true,
      useMcp: true,
      includeVaultContext: true,
      reasons: [
        "recommended_durable_escalation",
        "repeated_long_running_repo_work",
      ],
    });
  });

  it("accepts production Runtime V2 flag values", () => {
    expect(runtimeV2EnabledFromEnv("1")).toBe(true);
    expect(runtimeV2EnabledFromEnv("true")).toBe(true);
    expect(runtimeV2EnabledFromEnv("yes")).toBe(true);
    expect(runtimeV2EnabledFromEnv("on")).toBe(true);
    expect(runtimeV2EnabledFromEnv("0")).toBe(false);
    expect(runtimeV2EnabledFromEnv(undefined)).toBe(false);
  });
});

describe("applyActivatedSkillRoute", () => {
  it("keeps no-tool activated skills on the tool catalog lane with context", () => {
    const route = decideChatRuntimeRoute({
      message: "/email-drafter write a friendlier note",
    });
    expect(applyActivatedSkillRoute(route)).toMatchObject({
      lane: "tool-local",
      runtimeTarget: "bedrock-agent",
      useWorker: false,
      useMcp: true,
      includeVaultContext: true,
      reasons: ["model_decided_tool_catalog", "explicit_skill_activation"],
    });
  });

  it("keeps activated skills with declared tools on the local tool lane", () => {
    const route = decideChatRuntimeRoute({
      message: "/developer-briefing recap this",
    });
    expect(
      applyActivatedSkillRoute(route, { requiredProviders: ["github"] }),
    ).toMatchObject({
      lane: "tool-local",
      runtimeTarget: "bedrock-agent",
      useWorker: false,
      useMcp: true,
      includeVaultContext: true,
      reasons: [
        "model_decided_tool_catalog",
        "explicit_skill_activation",
        "activated_skill_requires_tools",
      ],
    });
  });

  it("preserves the durable worker lane for activated long-running work", () => {
    const route = decideChatRuntimeRoute({
      message: "/developer-briefing implement the settings page and run tests",
    });

    expect(
      applyActivatedSkillRoute(route, { requiredProviders: ["github"] }),
    ).toMatchObject({
      lane: "durable-local",
      runtimeTarget: "agentcore-worker",
      useWorker: true,
      useMcp: true,
      includeVaultContext: true,
      reasons: [
        "implementation_work",
        "explicit_skill_activation",
        "activated_skill_requires_tools",
      ],
    });
  });
});

describe("explainChatRuntimeRoute", () => {
  it("explains the two live lanes and legacy persisted routes", () => {
    expect(
      explainChatRuntimeRoute(
        decideChatRuntimeRoute({ message: "how are you?" }),
      ),
    ).toContain("authorized tool catalog");
    expect(
      explainChatRuntimeRoute(
        decideChatRuntimeRoute({
          message: "implement the settings feature in the repo",
        }),
      ),
    ).toContain("durable");
    // Legacy regex-engine routes replayed from persisted runs keep an
    // honest explanation of how they actually ran.
    expect(
      explainChatRuntimeRoute({
        lane: "fast-local",
        routingMode: "regex",
        executionMode: "local",
        runtimeTarget: "direct-chat",
        useWorker: false,
        useMcp: false,
        includeVaultContext: false,
        reasons: ["default_fast_local"],
      }),
    ).toContain("fast local chat");
    expect(
      explainChatRuntimeRoute({
        lane: "tool-local",
        routingMode: "regex",
        executionMode: "local",
        runtimeTarget: "bedrock-agent",
        useWorker: false,
        useMcp: true,
        includeVaultContext: false,
        reasons: ["github_provider_lookup"],
      }),
    ).toContain("Mounted local tools");
  });
});

describe("buildChatRouteReceipt", () => {
  it("builds a compact route receipt with context and tool availability", () => {
    const capabilityGraph = buildCapabilityGraph({
      userId: "user-1",
      providerStatus: {
        connectedProviders: ["github"],
        allowedProviders: ["github"],
        deniedProviders: [],
      },
      skills: [
        {
          id: "skill-1",
          slug: "weekly-status",
          name: "Weekly Status",
          ownerUserId: "user-1",
          isStarter: false,
          mcpProviders: ["github"],
        },
      ],
    });
    const route = decideChatRuntimeRoute({
      message: "What PRs am I reviewing?",
      capabilityGraph,
    });
    const receipt = buildChatRouteReceipt({
      route,
      contextSignals: {
        priorUserMessagesCount: 2,
        vaultMemoryAvailable: true,
        uploadedFilesAvailable: true,
      },
      capabilityGraph,
    });

    expect(receipt).toMatchObject({
      lane: "tool-local",
      routingMode: "model-decided",
      useMcp: true,
      contextAvailability: {
        priorUserMessages: 2,
        vaultMemoryAvailable: true,
        uploadedFilesAvailable: true,
      },
      toolAvailability: {
        connectedProviders: ["github"],
        approvedProviders: ["github"],
      },
      capabilityAvailability: {
        providers: 1,
        skills: 1,
        apps: 0,
        schedules: 0,
        runnableNow: 2,
        needsApproval: 0,
      },
    });
    expect(receipt.explanation).toContain("authorized tool catalog");
  });

  it("reports legacy persisted routes without a routing mode as regex", () => {
    const receipt = buildChatRouteReceipt({
      route: {
        lane: "durable-local",
        executionMode: "local",
        runtimeTarget: "agentcore-worker",
        useWorker: true,
        useMcp: true,
        includeVaultContext: true,
        reasons: ["implementation_work"],
      },
    });
    expect(receipt.routingMode).toBe("regex");
  });
});
