import type { ChatRuntimeRoute } from "@/lib/chat-routing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentPreamble } from "@/lib/agent-preamble";
import {
  FULL_DEPLOYMENT_CAPABILITIES,
  type DeploymentCapabilities,
} from "@/lib/deployment-capabilities";
import { seedableStarterSkills, STARTER_SKILLS } from "@/lib/starter-skills";

/**
 * Koch migration WP-04, honesty spine: a capability the deployment removes
 * must also leave the assistant's capability statement.
 */

const user = { displayName: "Rob", customInstructions: null };

function preamble(
  deployment: DeploymentCapabilities | undefined,
  builtinTools: string[] = [],
) {
  return buildAgentPreamble({
    user,
    connectedProviders: [],
    builtinTools,
    ...(deployment ? { deployment } : {}),
  });
}

const KOCH: DeploymentCapabilities = {
  connectors: ["github", "salesforce"],
  disabledConnectors: ["notion", "google"],
  connectorsWithoutChatTools: [],
  webSearch: false,
  webFetch: false,
};

describe("capability statement follows the deployment", () => {
  it("is unchanged when nothing is removed", () => {
    expect(preamble(FULL_DEPLOYMENT_CAPABILITIES, ["web__fetch_url"])).toBe(
      preamble(undefined, ["web__fetch_url"]),
    );
    const full = preamble(undefined);
    expect(full).toContain("use web search for current public information");
    expect(full).toContain("(for GitHub: Settings → Integrations");
    expect(full).not.toContain("Connectors not offered in this deployment");
    expect(full).not.toContain("have no chat tools here");
    expect(full).not.toContain("this deployment has no public web tools");
  });

  it("says web access is unavailable when search and fetch are both removed", () => {
    const text = preamble(KOCH);
    expect(text).toContain(
      "Web access: this deployment has no public web tools — no web search and no URL fetch.",
    );
    expect(text).toContain("say plainly that web access is not available here");
    expect(text).not.toContain("use web search for current public information");
    expect(text).not.toContain("call the URL fetch tool");
  });

  it("does not tell the model to use web search when only search is removed", () => {
    const text = preamble({ ...KOCH, webFetch: true }, ["web__fetch_url"]);
    expect(text).not.toContain("use web search for current public information");
    expect(text).toContain("- Public URL fetch:");
    expect(text).toContain("call the URL fetch tool before answering");
    expect(text).not.toContain("this deployment has no public web tools");
  });

  it("does not describe a URL fetch tool when only fetch is removed", () => {
    const text = preamble({ ...KOCH, webSearch: true }, ["web__search"]);
    expect(text).toContain("- Web search:");
    expect(text).not.toContain("- Public URL fetch:");
    expect(text).not.toContain("call the URL fetch tool before answering");
    expect(text).not.toContain("Web evidence discipline");
  });

  it("names the connectors that are not offered and stops pointing at them", () => {
    const text = preamble(KOCH);
    expect(text).toContain(
      "Connectors not offered in this deployment: Notion, Google Mail & Calendar.",
    );
    expect(text).toContain("it is not available in this deployment");
    expect(text).toContain("(for GitHub: Settings → Integrations");
  });

  it("drops the GitHub connect hint when GitHub is not offered", () => {
    const text = preamble({
      ...KOCH,
      connectors: ["salesforce"],
      disabledConnectors: ["github", "notion", "google"],
    });
    expect(text).not.toContain("(for GitHub:");
    expect(text).toContain("each service there has a Connect button.");
  });

  it("says a connector with no MCP server has no chat tools", () => {
    const text = preamble({ ...KOCH, connectorsWithoutChatTools: ["github"] });
    expect(text).toContain(
      "Connectors that can be linked in this deployment but have no chat tools here: GitHub.",
    );
    expect(text).toContain(
      "do not tell them that connecting one will let you use it",
    );
    expect(preamble(KOCH)).not.toContain("have no chat tools here");
  });
});

describe("built-in web tools follow the deployment", () => {
  const webRoute = { reasons: ["web_search_lookup"] } as ChatRuntimeRoute;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function tools(env: Record<string, string>) {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const { builtinToolsForChatRoute } = await import(
      "@/lib/runtime-builtin-tools"
    );
    return builtinToolsForChatRoute(webRoute);
  }

  it("mounts nothing when fetch is off and search is none", async () => {
    expect(
      await tools({ WEB_FETCH_ENABLED: "0", WEB_SEARCH_PROVIDER: "none" }),
    ).toEqual([]);
  });

  it("mounts search alone when only fetch is off", async () => {
    expect(
      await tools({
        WEB_FETCH_ENABLED: "0",
        WEB_SEARCH_PROVIDER: "brave",
        BRAVE_SEARCH_API_KEY: "test-key",
      }),
    ).toEqual(["web__search"]);
  });

  it("treats WEB_SEARCH_PROVIDER=none as no search even with a key present", async () => {
    expect(
      await tools({
        WEB_SEARCH_PROVIDER: "none",
        BRAVE_SEARCH_API_KEY: "test-key",
      }),
    ).toEqual(["web__fetch_url"]);
  });

  it("reports the same capabilities the tools were mounted from", async () => {
    vi.stubEnv("WEB_FETCH_ENABLED", "0");
    vi.stubEnv("WEB_SEARCH_PROVIDER", "none");
    vi.stubEnv("ENABLED_CONNECTOR_PROVIDERS", "salesforce,github");
    const { deploymentCapabilities } = await import(
      "@/lib/deployment-capabilities"
    );
    expect(deploymentCapabilities()).toEqual({
      connectors: ["github", "salesforce"],
      disabledConnectors: ["notion", "google"],
      connectorsWithoutChatTools: [],
      webSearch: false,
      webFetch: false,
    });
  });

  it("reports GitHub as having no chat tools when its MCP URL is empty", async () => {
    vi.stubEnv("GITHUB_MCP_URL", "");
    const { deploymentCapabilities } = await import(
      "@/lib/deployment-capabilities"
    );
    expect(deploymentCapabilities().connectorsWithoutChatTools).toEqual([
      "github",
    ]);
    expect(deploymentCapabilities().connectors).toContain("github");
  });

  it("does not report it when the GitHub connector is off altogether", async () => {
    vi.stubEnv("GITHUB_MCP_URL", "");
    vi.stubEnv("ENABLED_CONNECTOR_PROVIDERS", "salesforce");
    const { deploymentCapabilities } = await import(
      "@/lib/deployment-capabilities"
    );
    expect(deploymentCapabilities().connectorsWithoutChatTools).toEqual([]);
  });
});

describe("starter skills follow the deployment", () => {
  it("seeds every starter when every connector is offered", () => {
    expect(
      seedableStarterSkills(["github", "notion", "google", "salesforce"]),
    ).toEqual([...STARTER_SKILLS]);
  });

  it("leaves out starters that need a connector that is not offered", () => {
    const seedable = seedableStarterSkills(["github", "salesforce"]);
    expect(seedable.length).toBeGreaterThan(0);
    expect(seedable.length).toBeLessThan(STARTER_SKILLS.length);
    for (const starter of seedable) {
      expect(starter.mcpProviders).not.toContain("google");
    }
  });
});
