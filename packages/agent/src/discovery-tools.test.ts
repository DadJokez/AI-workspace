import { describe, expect, it } from "vitest";
import type {
  BedrockClient,
  BedrockStreamEvent,
  ConverseStreamParams,
} from "./clients";
import {
  ACTIVATE_TOOLS_NAME,
  createDiscoveryTools,
  SEARCH_TOOLS_NAME,
  type DiscoveryCatalogEntry,
} from "./discovery-tools";
import { runAgentLoop } from "./loop";
import { ToolRegistry } from "./registry";
import { resolveMountedToolNames } from "./tool-bundles";

const CATALOG: DiscoveryCatalogEntry[] = [
  {
    provider: "github",
    tool: "list_pull_requests",
    description: "List pull requests in a repository.",
    category: "repos",
    action: "read",
  },
  {
    provider: "github",
    tool: "create_issue",
    description: "Create an issue in a repository.",
    category: "repos",
    action: "write",
  },
  {
    provider: "notion",
    tool: "search",
    description: "Search Notion pages and databases.",
    category: "docs",
    action: "read",
  },
];

function tools(activated: Set<string>) {
  return createDiscoveryTools({
    catalog: CATALOG,
    activatedProviders: activated,
  });
}

describe("createDiscoveryTools", () => {
  it("search ranks matches and reports mounted state per provider", async () => {
    const [search] = tools(new Set(["notion"]));
    const output = (await search!.handler(
      { query: "pull requests" },
      { userId: "u1" },
    )) as {
      providers: Array<{ provider: string; toolCount: number; mounted: boolean }>;
      results: Array<{ provider: string; tool: string; mounted: boolean }>;
      note: string;
    };

    expect(output.results[0]).toMatchObject({
      provider: "github",
      tool: "list_pull_requests",
      mounted: false,
    });
    expect(output.providers).toEqual([
      { provider: "github", toolCount: 2, mounted: false },
      { provider: "notion", toolCount: 1, mounted: true },
    ]);
    expect(output.note).toContain("not instructions");
  });

  it("activation mutates the shared set, is idempotent, and refuses unknown providers", async () => {
    const activated = new Set<string>();
    const [, activate] = tools(activated);

    const first = (await activate!.handler(
      { provider: "github" },
      { userId: "u1" },
    )) as { ok: boolean; provider?: string };
    expect(first).toMatchObject({ ok: true, provider: "github" });
    expect(activated.has("github")).toBe(true);

    const again = (await activate!.handler(
      { provider: "github" },
      { userId: "u1" },
    )) as { ok: boolean; alreadyActive?: boolean };
    expect(again).toMatchObject({ ok: true, alreadyActive: true });

    const unknown = (await activate!.handler(
      { provider: "slack" },
      { userId: "u1" },
    )) as { ok: boolean; reason?: string; availableProviders?: string[] };
    expect(unknown).toMatchObject({
      ok: false,
      reason: "provider_not_available",
    });
    expect(unknown.availableProviders).toEqual(["github", "notion"]);
    expect(activated.has("slack")).toBe(false);
  });
});

/**
 * The P2 flagship flow: from a core bundle, the model activates github and
 * the NEXT iteration mounts its tools — one user-visible turn, no
 * re-prompting.
 */
class DiscoveryFlowClient implements BedrockClient {
  readonly captured: ConverseStreamParams[] = [];

  async *converseStream(
    params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    this.captured.push(params);
    if (this.captured.length === 1) {
      yield {
        type: "tool-use",
        id: "activate-1",
        name: ACTIVATE_TOOLS_NAME,
        input: { provider: "github" },
      };
      yield { type: "stop", reason: "tool_use" };
      return;
    }
    if (this.captured.length === 2) {
      yield {
        type: "tool-use",
        id: "list-1",
        name: "github__list_pull_requests",
        input: {},
      };
      yield { type: "stop", reason: "tool_use" };
      return;
    }
    yield { type: "text-delta", text: "You have 2 open PRs." };
    yield { type: "stop", reason: "end_turn" };
  }
}

describe("mid-turn activation through the loop (#384 P2)", () => {
  it("activates github and mounts its tools on the next iteration", async () => {
    const activated = new Set<string>();
    const registry = new ToolRegistry();
    registry.registerAll(
      createDiscoveryTools({ catalog: CATALOG, activatedProviders: activated }),
    );
    const dynamicToolNames = new Set(["github__list_pull_requests"]);
    registry.register({
      name: "github__list_pull_requests",
      description: "List pull requests.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ pullRequests: 2 }),
    });

    const client = new DiscoveryFlowClient();
    const events = [];
    for await (const event of runAgentLoop({
      modelId: "sonnet-4-6",
      messages: [{ role: "user", content: "check my PRs" }],
      registry,
      resolveAllowedTools: () =>
        resolveMountedToolNames(
          registry.list().map((tool) => tool.name),
          dynamicToolNames,
          activated,
        ),
      context: { userId: "u1" },
      client,
    })) {
      events.push(event);
    }

    const mountedPerIteration = client.captured.map((params) =>
      params.toolConfig?.tools.map((tool) => tool.toolSpec.name),
    );
    // Core bundle first: discovery tools only. Post-activation: github too.
    expect(mountedPerIteration[0]).toEqual([
      SEARCH_TOOLS_NAME,
      ACTIVATE_TOOLS_NAME,
    ]);
    expect(mountedPerIteration[1]).toContain("github__list_pull_requests");
    expect(events).toContainEqual({
      type: "tool-result",
      result: {
        toolCallId: "list-1",
        output: { pullRequests: 2 },
      },
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events).toContainEqual({ type: "done" });
  });
});
