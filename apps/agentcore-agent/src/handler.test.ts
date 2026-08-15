import { describe, expect, it } from "vitest";
import {
  createDiscoveryTools,
  resolveMountedToolNames,
  ToolRegistry,
  type AgentEvent,
  type BedrockClient,
  type BedrockStreamEvent,
  type ConverseStreamParams,
} from "@ai-workspace/agent";
import { parseInvocationPayload, runInvocation } from "./handler";

/**
 * The AgentCore lane's tool-discovery parity pin (#384, promised in the P1
 * review): payload → parseInvocationPayload → the same mounted-name
 * resolution runInvocation wires. The Bedrock lane pins byte parity against
 * a live loopback server; this closes the container lane's parsing +
 * gating gap without a Bedrock dependency.
 */

const BASE_PAYLOAD = {
  modelId: "sonnet-4-6",
  messages: [{ role: "user", content: "check my PRs" }],
};

describe("parseInvocationPayload toolDiscovery", () => {
  it("round-trips activation and catalog into mounted names", () => {
    const payload = parseInvocationPayload({
      ...BASE_PAYLOAD,
      toolDiscovery: {
        activatedProviders: ["google"],
        catalog: [
          {
            provider: "github",
            tool: "list_pull_requests",
            description: "List PRs.",
            category: "repos",
            action: "read",
          },
        ],
      },
    });

    expect(payload.toolDiscovery).toEqual({
      activatedProviders: ["google"],
      catalog: [
        {
          provider: "github",
          tool: "list_pull_requests",
          description: "List PRs.",
          category: "repos",
          action: "read",
        },
      ],
    });

    // Mirror runInvocation's wiring: discovery tools static, MCP names
    // gated by the activated set.
    const activated = new Set(payload.toolDiscovery!.activatedProviders);
    const registry = new ToolRegistry();
    registry.registerAll(
      createDiscoveryTools({
        catalog: payload.toolDiscovery!.catalog ?? [],
        activatedProviders: activated,
      }),
    );
    const dynamicToolNames = new Set([
      "github__list_pull_requests",
      "google__search_email",
    ]);
    for (const name of dynamicToolNames) {
      registry.register({
        name,
        description: name,
        inputSchema: { type: "object", properties: {} },
        handler: async () => ({}),
      });
    }
    const mounted = resolveMountedToolNames(
      registry.list().map((tool) => tool.name),
      dynamicToolNames,
      activated,
    );
    expect(mounted).toEqual([
      "comparative__search_tools",
      "comparative__activate_tools",
      "google__search_email",
    ]);
  });

  it("drops malformed catalog entries and non-string providers", () => {
    const payload = parseInvocationPayload({
      ...BASE_PAYLOAD,
      toolDiscovery: {
        activatedProviders: ["github", 42, null],
        catalog: [
          { provider: "github" },
          "junk",
          {
            provider: "notion",
            tool: "search",
            description: "Search pages.",
            category: "docs",
            action: "read",
          },
        ],
      },
    });
    expect(payload.toolDiscovery).toEqual({
      activatedProviders: ["github"],
      catalog: [
        {
          provider: "notion",
          tool: "search",
          description: "Search pages.",
          category: "docs",
          action: "read",
        },
      ],
    });
  });

  it("treats absent or malformed toolDiscovery as absent (mount everything)", () => {
    expect(parseInvocationPayload(BASE_PAYLOAD).toolDiscovery).toBeUndefined();
    expect(
      parseInvocationPayload({ ...BASE_PAYLOAD, toolDiscovery: "junk" })
        .toolDiscovery,
    ).toBeUndefined();
    expect(
      parseInvocationPayload({ ...BASE_PAYLOAD, toolDiscovery: {} })
        .toolDiscovery,
    ).toBeUndefined();
  });
});

describe("parseInvocationPayload just-in-time tool guidance", () => {
  it("keeps valid per-tool usage notes", () => {
    const payload = parseInvocationPayload({
      ...BASE_PAYLOAD,
      mcpServers: {
        github: {
          url: "https://mcp.example.test",
          usageNotesByTool: {
            create_issue: "Report the exact issue URL.",
            blank: "   ",
            invalid: 42,
          },
        },
      },
    });

    expect(payload.mcpServers?.github?.usageNotesByTool).toEqual({
      create_issue: "Report the exact issue URL.",
    });
  });

  it("keeps valid runtime policies and drops invalid policy values", () => {
    const payload = parseInvocationPayload({
      ...BASE_PAYLOAD,
      mcpServers: {
        github: {
          url: "https://mcp.example.test",
          toolPolicies: {
            list_pull_requests: "always_allow",
            create_issue: "needs_approval",
            delete_repository: "blocked",
            invalid: "allow_everything",
          },
          defaultToolPolicy: "needs_approval",
        },
        junk: {
          url: "https://junk.example.test",
          defaultToolPolicy: "anything",
        },
      },
    });

    expect(payload.mcpServers?.github?.toolPolicies).toEqual({
      list_pull_requests: "always_allow",
      create_issue: "needs_approval",
      delete_repository: "blocked",
    });
    expect(payload.mcpServers?.github?.defaultToolPolicy).toBe(
      "needs_approval",
    );
    expect(payload.mcpServers?.junk?.defaultToolPolicy).toBeUndefined();
  });

  it("keeps the canonical displayName and drops junk values (#713)", () => {
    const payload = parseInvocationPayload({
      ...BASE_PAYLOAD,
      mcpServers: {
        google: {
          url: "https://mcp.example.test",
          displayName: "Google Mail & Calendar",
        },
        github: { url: "https://mcp.example.test", displayName: 42 },
      },
    });

    expect(payload.mcpServers?.google?.displayName).toBe(
      "Google Mail & Calendar",
    );
    expect(payload.mcpServers?.github?.displayName).toBeUndefined();
  });
});

/**
 * #713 in the container lane: a provider that fails to mount becomes a
 * degraded (non-fatal) error event and honest system-prompt guidance, and
 * the turn still completes.
 */
describe("runInvocation degraded MCP mounting (#713)", () => {
  it("emits a degraded event, tells the model honestly, and completes the turn", async () => {
    const captured: { systemPrompt?: string } = {};
    const client: BedrockClient = {
      async *converseStream(
        params: ConverseStreamParams,
      ): AsyncIterable<BedrockStreamEvent> {
        captured.systemPrompt = params.systemPrompt;
        yield { type: "text-delta", text: "ok" } as BedrockStreamEvent;
        yield { type: "stop", reason: "end_turn" } as BedrockStreamEvent;
      },
    };

    const events: AgentEvent[] = [];
    await runInvocation(
      parseInvocationPayload({
        ...BASE_PAYLOAD,
        systemPrompt: "SYSTEM",
        mcpServers: {
          google: {
            url: "http://127.0.0.1:9/",
            displayName: "Google Mail & Calendar",
          },
        },
      }),
      (event) => {
        events.push(event);
      },
      { client },
    );

    const errors = events.filter(
      (event): event is Extract<AgentEvent, { type: "error" }> =>
        event.type === "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.degradedProvider).toBe("google");
    expect(errors[0]!.message).toContain("MCP connection failed for google");
    expect(events.some((event) => event.type === "done")).toBe(true);

    expect(captured.systemPrompt).toContain("SYSTEM");
    expect(captured.systemPrompt).toContain(
      "Google Mail & Calendar needs to be reconnected in Settings → Integrations before I can use it.",
    );
  });
});

describe("parseInvocationPayload userTimeZone (#432)", () => {
  it("keeps a valid IANA zone from the payload", () => {
    expect(
      parseInvocationPayload({
        ...BASE_PAYLOAD,
        userTimeZone: "America/New_York",
      }).userTimeZone,
    ).toBe("America/New_York");
  });

  it("drops garbage, offsets, and non-string values at the trust boundary", () => {
    expect(
      parseInvocationPayload({
        ...BASE_PAYLOAD,
        userTimeZone: "'; DROP TABLE runs;--",
      }).userTimeZone,
    ).toBeUndefined();
    expect(
      parseInvocationPayload({ ...BASE_PAYLOAD, userTimeZone: "+05:30" })
        .userTimeZone,
    ).toBeUndefined();
    expect(
      parseInvocationPayload({ ...BASE_PAYLOAD, userTimeZone: 42 })
        .userTimeZone,
    ).toBeUndefined();
    expect(parseInvocationPayload(BASE_PAYLOAD).userTimeZone).toBeUndefined();
  });
});

describe("parseInvocationPayload web egress policy", () => {
  it("keeps the named denylist policy", () => {
    expect(
      parseInvocationPayload({
        ...BASE_PAYLOAD,
        webEgressPolicy: {
          name: "admin_domain_denylist",
          deniedDomains: ["blocked.example"],
        },
      }).webEgressPolicy,
    ).toEqual({
      name: "admin_domain_denylist",
      deniedDomains: ["blocked.example"],
    });
  });

  it("drops malformed or unknown policies at the runtime boundary", () => {
    expect(
      parseInvocationPayload({
        ...BASE_PAYLOAD,
        webEgressPolicy: {
          name: "unknown_policy",
          deniedDomains: ["blocked.example"],
        },
      }).webEgressPolicy,
    ).toBeUndefined();
    expect(
      parseInvocationPayload({
        ...BASE_PAYLOAD,
        webEgressPolicy: {
          name: "admin_domain_denylist",
          deniedDomains: "blocked.example",
        },
      }).webEgressPolicy,
    ).toBeUndefined();
  });
});
