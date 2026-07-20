import { describe, expect, it } from "vitest";
import {
  createDiscoveryTools,
  resolveMountedToolNames,
  ToolRegistry,
} from "@ai-workspace/agent";
import { parseInvocationPayload } from "./handler";

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
