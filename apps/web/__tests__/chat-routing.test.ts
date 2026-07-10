import { describe, expect, it, vi } from "vitest";
import { buildCapabilityGraph } from "@/lib/capability-graph";
import {
  applyActivatedSkillRoute,
  buildChatRouteReceipt,
  decideChatRuntimeRoute,
  runtimeV2EnabledFromEnv,
} from "@/lib/chat-routing";

describe("decideChatRuntimeRoute", () => {
  it("defaults simple chat to fast local streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "say pong and nothing else",
      }),
    ).toMatchObject({
      lane: "fast-local",
      executionMode: "local",
      runtimeTarget: "direct-chat",
      runtimeV2: false,
      useWorker: false,
      useMcp: false,
      includeVaultContext: false,
    });
  });

  it("routes simple Runtime V2 chat to direct local streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "say pong and nothing else",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      executionMode: "local",
      runtimeTarget: "direct-chat",
      runtimeV2: true,
      useWorker: false,
      useMcp: false,
      includeVaultContext: false,
      reasons: ["default_fast_local"],
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

  it("ignores the removed cloud execution mode", () => {
    expect(
      decideChatRuntimeRoute({
        message: "say pong and nothing else",
        executionMode: "cloud",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      executionMode: "local",
      runtimeTarget: "direct-chat",
      useWorker: false,
      useMcp: false,
    });
  });

  it("routes GitHub inspection to local tool streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Check GitHub issue #123 and summarize it",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "bedrock-agent",
      useWorker: false,
      useMcp: true,
    });
  });

  it("routes GitHub shorthand PR summaries to local tool streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Can you take a peek in my Gh and summarize the last 3 prs",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "bedrock-agent",
      useWorker: false,
      useMcp: true,
    });
  });

  it("routes bare recent PR summaries to local tool streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "summarize the last three PRs",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "bedrock-agent",
      useWorker: false,
      useMcp: true,
      reasons: ["github_recent_work_lookup"],
    });
  });

  it("routes natural repo delivery asks to local tool streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "what shipped in my repos this week?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "bedrock-agent",
      useWorker: false,
      useMcp: true,
      reasons: ["github_owned_work_lookup"],
    });
  });

  it("routes public URL inspection to local tool streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "https://example.com/ what is the html for this site?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "bedrock-agent",
      useWorker: false,
      useMcp: true,
      reasons: ["web_url_lookup"],
    });
  });

  it("routes explicit web-search asks to the tool lane only when search is configured (#313)", () => {
    vi.stubEnv("WEB_SEARCH_PROVIDER", "brave");
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    expect(
      decideChatRuntimeRoute({
        message: "search the web for enterprise AI assistant reviews",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      reasons: ["web_search_lookup"],
    });

    // Unconfigured: no escalation, no web reason — the tool never mounts,
    // so the assistant honestly has no search this deployment.
    vi.stubEnv("WEB_SEARCH_PROVIDER", "");
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    const route = decideChatRuntimeRoute({
      message: "search the web for enterprise AI assistant reviews",
      runtimeV2: true,
    });
    expect(route.lane).toBe("fast-local");
    expect(route.reasons.some((r) => r.startsWith("web_"))).toBe(false);
    vi.unstubAllEnvs();
  });

  it("keeps URL inspection on the URL-fetch reason even when search is configured", () => {
    vi.stubEnv("WEB_SEARCH_PROVIDER", "brave");
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "test-key");
    expect(
      decideChatRuntimeRoute({
        message: "https://example.com/ what is the html for this site?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      reasons: ["web_url_lookup"],
    });
    vi.unstubAllEnvs();
  });

  it("keeps Notion document lookups on fast chat until Notion is executable", () => {
    expect(
      decideChatRuntimeRoute({
        message: "search my Notion docs for the launch notes",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      executionMode: "local",
      runtimeTarget: "direct-chat",
      useWorker: false,
      useMcp: false,
      reasons: ["default_fast_local"],
    });
  });

  it("routes Notion lookups only when Notion is model-available", () => {
    expect(
      decideChatRuntimeRoute({
        message: "search my Notion docs for the launch notes",
        runtimeV2: true,
        capabilitySignals: {
          connectedProviders: ["notion"],
          approvedProviders: ["notion"],
        },
      }),
    ).toMatchObject({
      lane: "tool-local",
      runtimeTarget: "bedrock-agent",
      useMcp: true,
      reasons: ["capability_graph_notion_lookup"],
    });
  });

  it("does not route generic database/page language to Notion", () => {
    expect(
      decideChatRuntimeRoute({
        message: "list the databases and show me the pages",
        runtimeV2: true,
        capabilitySignals: {
          connectedProviders: ["notion"],
          approvedProviders: ["notion"],
        },
      }),
    ).toMatchObject({
      lane: "fast-local",
      useMcp: false,
      reasons: ["default_fast_local"],
    });
  });

  it("routes Gmail and Calendar requests to the fast tool lane when Google is ready", () => {
    for (const message of [
      "Search my Gmail for the launch thread",
      "What is on my calendar tomorrow?",
      "Draft an email to Sam about the project",
      "Create a meeting with Sam next Tuesday",
    ]) {
      expect(
        decideChatRuntimeRoute({
          message,
          runtimeV2: true,
          capabilitySignals: {
            connectedProviders: ["google"],
            approvedProviders: ["google"],
          },
        }),
      ).toMatchObject({
        lane: "tool-local",
        runtimeTarget: "bedrock-agent",
        useWorker: false,
        useMcp: true,
        reasons: ["capability_graph_google_mail_calendar"],
      });
    }
  });

  it("does not pretend Google tools are available before the provider is ready", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Search my Gmail for the launch thread",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      useMcp: false,
      reasons: ["default_fast_local"],
    });
  });

  it("routes GitHub capability probes to local tool streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "You can't access git hub",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "bedrock-agent",
      useWorker: false,
      useMcp: true,
      reasons: ["github_capability_probe"],
    });
  });

  it("routes connected-tool repo visibility checks to local tool streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Tools says it's connected. Try if you can see my repos.",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "bedrock-agent",
      useWorker: false,
      useMcp: true,
      reasons: ["github_capability_probe"],
    });
  });

  it("routes natural personal PR review prompts to local tool streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "What PRs am I reviewing?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "bedrock-agent",
      useWorker: false,
      useMcp: true,
      reasons: ["github_owned_work_lookup"],
    });
  });

  it("routes CI status checks to local tool streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Anything failing CI?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "bedrock-agent",
      useWorker: false,
      useMcp: true,
      reasons: ["github_ci_status_lookup"],
    });
  });

  it("treats numbered PR lookup as tool work, not durable PR creation", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Open PR #123 and summarize it",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "bedrock-agent",
      useWorker: false,
      useMcp: true,
      reasons: ["github_numbered_reference"],
    });
  });

  it("does not mount tools for generic educational PR questions", () => {
    expect(
      decideChatRuntimeRoute({
        message: "What is a pull request?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      runtimeTarget: "direct-chat",
      useWorker: false,
      useMcp: false,
    });
  });

  it("does not mount tools for generic issue wording without work-system intent", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Show me the issues with this plan",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      runtimeTarget: "direct-chat",
      useWorker: false,
      useMcp: false,
    });
  });

  it("routes implementation work to the durable local worker", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Implement the new settings page and run tests",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "durable-local",
      executionMode: "local",
      runtimeTarget: "agentcore-worker",
      useWorker: true,
      useMcp: true,
    });
  });

  it("keeps personal-context asks local while including vault context", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Based on what you know about my preferences, which option is better?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      executionMode: "local",
      runtimeTarget: "direct-chat",
      useWorker: false,
      useMcp: false,
      includeVaultContext: true,
    });
  });

  it("can include Vault context based on context signals even on a tool lane", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Check GitHub for anything related to my priorities",
        runtimeV2: true,
        contextSignals: { vaultMemoryAvailable: true },
      }),
    ).toMatchObject({
      lane: "tool-local",
      useMcp: true,
      includeVaultContext: true,
    });
  });

  it("keeps no-tool activated skills on the fast lane while adding context", () => {
    const route = decideChatRuntimeRoute({
      message: "/email-drafter write a friendlier note",
      runtimeV2: true,
    });
    expect(applyActivatedSkillRoute(route)).toMatchObject({
      lane: "fast-local",
      runtimeTarget: "direct-chat",
      useWorker: false,
      useMcp: false,
      includeVaultContext: true,
      reasons: ["default_fast_local", "explicit_skill_activation"],
    });
  });

  it("upgrades activated skills with declared tools to the local tool lane", () => {
    const route = decideChatRuntimeRoute({
      message: "/developer-briefing recap this",
      runtimeV2: true,
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
        "default_fast_local",
        "explicit_skill_activation",
        "activated_skill_requires_tools",
      ],
    });
  });

  it("preserves the durable worker lane for activated long-running work", () => {
    const route = decideChatRuntimeRoute({
      message: "/developer-briefing implement the settings page and run tests",
      runtimeV2: true,
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

  it("treats name/profile questions as personal context", () => {
    expect(
      decideChatRuntimeRoute({
        message: "whats my name",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      runtimeTarget: "direct-chat",
      includeVaultContext: true,
    });
  });

  it("treats context inventory questions as personal context", () => {
    expect(
      decideChatRuntimeRoute({
        message: "What context do you have about me?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      runtimeTarget: "direct-chat",
      includeVaultContext: true,
      reasons: ["personal_context_intent"],
    });
  });

  it("treats bare context and memory inventory questions as personal context", () => {
    expect(
      decideChatRuntimeRoute({
        message: "What context do you have?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      runtimeTarget: "direct-chat",
      includeVaultContext: true,
      reasons: ["personal_context_intent"],
    });

    expect(
      decideChatRuntimeRoute({
        message: "What do you remember about me?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      includeVaultContext: true,
      reasons: ["personal_context_intent"],
    });
  });

  it("treats job and role questions as personal context", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Do you know my role?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      includeVaultContext: true,
      reasons: ["personal_context_intent"],
    });
  });

  it("treats focus/priorities questions as personal context", () => {
    expect(
      decideChatRuntimeRoute({
        message: "What should I focus on today?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      includeVaultContext: true,
      reasons: ["personal_context_intent"],
    });
  });

  it("does not route generic knowledge questions through Vault", () => {
    expect(
      decideChatRuntimeRoute({
        message: "What do you know about quantum computing?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      useMcp: false,
      includeVaultContext: false,
      reasons: ["default_fast_local"],
    });
  });

  // Conversation-level tool stickiness. Born from a real failure: the model
  // answered "no GitHub issues", then a turn later — asked "what repos did you
  // check?" — said "I don't actually have access to GitHub". The follow-up had
  // no tool keywords so it dropped to the tool-less fast lane and contradicted
  // itself. Stickiness keeps GitHub mounted across the thread.
  it("keeps tools mounted on a follow-up after a thread already used them", () => {
    expect(
      decideChatRuntimeRoute({
        message: "what did you check?",
        runtimeV2: true,
        priorUserMessages: [
          "Open GitHub issues assigned to me — what should I tackle first?",
        ],
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "bedrock-agent",
      useWorker: false,
      useMcp: true,
      reasons: ["sticky_tool_thread"],
    });
  });

  it("uses the capability graph to route ambiguous connected-work asks to tools", () => {
    const capabilityGraph = buildCapabilityGraph({
      userId: "user-1",
      providerStatus: {
        connectedProviders: ["github"],
        allowedProviders: ["github"],
        deniedProviders: [],
      },
    });

    expect(
      decideChatRuntimeRoute({
        message: "What should I tackle first?",
        runtimeV2: true,
        capabilityGraph,
      }),
    ).toMatchObject({
      lane: "tool-local",
      runtimeTarget: "bedrock-agent",
      useWorker: false,
      useMcp: true,
      reasons: ["capability_graph_github_work_lookup"],
    });
  });

  it("does not route ambiguous connected-work asks to tools without an approved provider", () => {
    const capabilityGraph = buildCapabilityGraph({
      userId: "user-1",
      providerStatus: {
        connectedProviders: ["github"],
        allowedProviders: [],
        deniedProviders: ["github"],
      },
    });

    expect(
      decideChatRuntimeRoute({
        message: "What should I tackle first?",
        runtimeV2: true,
        capabilityGraph,
      }),
    ).toMatchObject({
      lane: "fast-local",
      runtimeTarget: "direct-chat",
      useMcp: false,
      reasons: ["default_fast_local"],
    });
  });

  it("surfaces approval-blocked providers in the route receipt without mounting tools", () => {
    const capabilityGraph = buildCapabilityGraph({
      userId: "user-1",
      providerStatus: {
        connectedProviders: ["github"],
        allowedProviders: [],
        deniedProviders: ["github"],
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
      message: "What should I tackle first?",
      runtimeV2: true,
      capabilityGraph,
    });
    const receipt = buildChatRouteReceipt({
      route,
      capabilityGraph,
    });

    expect(receipt).toMatchObject({
      lane: "fast-local",
      useMcp: false,
      toolAvailability: {
        connectedProviders: ["github"],
        approvedProviders: [],
        pendingApprovalProviders: ["github"],
      },
      capabilityAvailability: {
        providers: 1,
        skills: 1,
        apps: 0,
        schedules: 0,
        runnableNow: 0,
        needsApproval: 2,
      },
    });
    expect(receipt.explanation).toContain("Used fast local chat");
  });

  it("does not stick tools when no earlier turn needed them", () => {
    expect(
      decideChatRuntimeRoute({
        message: "what did you check?",
        runtimeV2: true,
        priorUserMessages: ["tell me a joke", "now make it shorter"],
      }),
    ).toMatchObject({
      lane: "fast-local",
      runtimeTarget: "direct-chat",
      useWorker: false,
      useMcp: false,
    });
  });

  it("stickiness upgrades a follow-up to inline tools, never the durable worker", () => {
    // A prior durable turn shouldn't force every later chit-chat turn into the
    // background worker — keep tools warm inline instead.
    expect(
      decideChatRuntimeRoute({
        message: "thanks — what did that change?",
        runtimeV2: true,
        priorUserMessages: ["Implement the new settings page and run tests"],
      }),
    ).toMatchObject({
      lane: "tool-local",
      useWorker: false,
      useMcp: true,
      reasons: ["sticky_tool_thread"],
    });
  });

  it("escalates a proceed-style follow-up after durable planning to the worker", () => {
    expect(
      decideChatRuntimeRoute({
        message: "go ahead and do it",
        runtimeV2: true,
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

  it("accepts recommended durable escalation from capability/context signals", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Take this on when you can",
        runtimeV2: true,
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
      runtimeV2: true,
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
    expect(receipt.explanation).toContain("Mounted local tools");
    expect(receipt.explanation).toContain("GitHub");
  });
});
