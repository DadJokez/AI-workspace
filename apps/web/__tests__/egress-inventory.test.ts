import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANY_HOST,
  REFERENCE_EGRESS_SETTINGS,
  SALESFORCE_INSTANCE_HOSTS,
  buildEgressInventory,
  egressAllowlist,
  renderEgressInventoryMarkdown,
  type EgressEntry,
} from "@/lib/egress-inventory";
import { isTrustedSalesforceInstanceUrl } from "@/lib/oauth/salesforce";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const DOC_PATH = "docs/security/EGRESS_INVENTORY.md";

const reference = buildEgressInventory(REFERENCE_EGRESS_SETTINGS);

function hosts(entries: readonly EgressEntry[]): string[] {
  return entries.map((entry) => entry.host);
}

/** `*.example.com` covers subdomains. The any-host row covers nothing here. */
function covers(inventoryHost: string, host: string): boolean {
  if (inventoryHost === ANY_HOST) return false;
  if (inventoryHost.startsWith("*.")) {
    return host.endsWith(inventoryHost.slice(1));
  }
  return inventoryHost === host;
}

describe("egress inventory document", () => {
  it("is the generated one (run `pnpm egress:inventory` after a change)", () => {
    expect(readFileSync(path.join(REPO_ROOT, DOC_PATH), "utf8")).toBe(
      renderEgressInventoryMarkdown(),
    );
  });

  it("lists every destination from the survey", () => {
    for (const host of [
      "github.com",
      "api.github.com",
      "api.githubcopilot.com",
      "accounts.google.com",
      "oauth2.googleapis.com",
      "gmail.googleapis.com",
      "www.googleapis.com",
      "api.notion.com",
      "login.salesforce.com",
      "*.salesforce.com",
      "api.search.brave.com",
      "us.i.posthog.com",
      "email.<region>.amazonaws.com",
      "bedrock-runtime.<region>.amazonaws.com",
      "bedrock-agentcore.<region>.amazonaws.com",
      "secretsmanager.<region>.amazonaws.com",
      "logs.<region>.amazonaws.com",
      ANY_HOST,
    ]) {
      expect(hosts(reference), host).toContain(host);
    }
  });

  it("keeps AWS endpoints that have a VPC endpoint off the proxy", () => {
    const aws = reference.filter(
      (entry) =>
        entry.host.endsWith(".amazonaws.com") &&
        !entry.host.startsWith("email."),
    );
    expect(aws.length).toBeGreaterThan(0);
    expect(aws.filter((entry) => entry.viaProxy)).toEqual([]);
  });

  it("never marks a browser destination as going through our proxy", () => {
    expect(
      reference.filter(
        (entry) => entry.services.includes("browser") && entry.viaProxy,
      ),
    ).toEqual([]);
  });
});

describe("egress inventory follows the deployment", () => {
  const koch = buildEgressInventory({
    ...REFERENCE_EGRESS_SETTINGS,
    region: "us-east-2",
    sesRegion: "us-east-2",
    appHost: "internal-alb.example",
    appHostInternal: true,
    connectors: ["github", "salesforce"],
    githubSignIn: false,
    githubWebHost: "ghe.example",
    githubApiHost: "ghe.example",
    externalMcpHosts: {},
    webSearch: false,
    webFetch: false,
    studioBrowser: false,
    analyticsHosts: [],
  });

  it("names the GitHub Enterprise host and no github.com host", () => {
    expect(hosts(koch)).toContain("ghe.example");
    expect(hosts(koch).filter((host) => /github/.test(host))).toEqual([]);
  });

  it("drops the rows of everything that is switched off", () => {
    for (const gone of [
      "oauth2.googleapis.com",
      "accounts.google.com",
      "api.notion.com",
      "api.search.brave.com",
      "us.i.posthog.com",
      "us.posthog.com",
      ANY_HOST,
    ]) {
      expect(hosts(koch), gone).not.toContain(gone);
    }
    expect(hosts(koch)).toContain("login.salesforce.com");
  });

  it("drops GitHub altogether when it is neither a connector nor a sign-in", () => {
    const none = buildEgressInventory({
      ...REFERENCE_EGRESS_SETTINGS,
      connectors: ["salesforce"],
      githubSignIn: false,
    });
    expect(hosts(none).filter((host) => /github/.test(host))).toEqual([]);
  });

  it("sends the chat worker to the GitHub API only when event triggers poll", () => {
    const pollingWorkers = (githubEventPolling: boolean) =>
      buildEgressInventory({ ...REFERENCE_EGRESS_SETTINGS, githubEventPolling })
        .filter(
          (entry) =>
            entry.host === "api.github.com" &&
            entry.services.includes("chat-worker"),
        )
        .map((entry) => entry.enabledWhen);
    expect(pollingWorkers(false)).toEqual([]);
    expect(pollingWorkers(true)).toEqual([
      "github in ENABLED_CONNECTOR_PROVIDERS and GITHUB_EVENT_INGEST_MODE=poll",
    ]);
  });

  it("keeps GitHub's web and API hosts for sign-in when the connector is off", () => {
    const signInOnly = buildEgressInventory({
      ...REFERENCE_EGRESS_SETTINGS,
      connectors: ["salesforce"],
    });
    expect(hosts(signInOnly)).toContain("api.github.com");
    expect(hosts(signInOnly)).not.toContain("api.githubcopilot.com");
  });

  it("splits the server-side hosts into the proxy list and NO_PROXY", () => {
    expect(egressAllowlist(koch)).toEqual({
      proxyHosts: [
        "*.force.com",
        "*.salesforce.com",
        "email.us-east-2.amazonaws.com",
        "ghe.example",
        "login.salesforce.com",
      ],
      noProxy: [
        "127.0.0.1",
        "169.254.170.2",
        "bedrock-agentcore.us-east-2.amazonaws.com",
        "bedrock-runtime.us-east-2.amazonaws.com",
        "internal-alb.example",
        "localhost",
        "logs.us-east-2.amazonaws.com",
        "secretsmanager.us-east-2.amazonaws.com",
      ],
    });
  });

  it("never puts the any-host row in NO_PROXY", () => {
    const allowlist = egressAllowlist(reference);
    expect(allowlist.noProxy).not.toContain(ANY_HOST);
    // URL fetch does go through the proxy, to any host.
    expect(allowlist.proxyHosts).toContain(ANY_HOST);
  });
});

describe("egress inventory of this deployment", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the same settings the code runs on", async () => {
    vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
    vi.stubEnv("INTERNAL_BASE_URL", "");
    vi.stubEnv("AWS_REGION", "eu-west-1");
    vi.stubEnv("AUTH_PROVIDERS", "email");
    vi.stubEnv("ENABLED_CONNECTOR_PROVIDERS", "github,salesforce");
    vi.stubEnv("GITHUB_WEB_URL", "https://ghe.example");
    vi.stubEnv("GITHUB_API_URL", "https://ghe.example/api/v3");
    vi.stubEnv("GITHUB_MCP_URL", "https://ghe-mcp.example/mcp/");
    vi.stubEnv("SALESFORCE_LOGIN_URL", "https://test.salesforce.com");
    vi.stubEnv("WEB_SEARCH_PROVIDER", "none");
    vi.stubEnv("WEB_FETCH_ENABLED", "0");
    vi.stubEnv("ANALYTICS_PROVIDER", "none");
    vi.stubEnv("INVITE_EMAIL_PROVIDER", "disabled");
    vi.stubEnv("AGENTCORE_RUNTIME_ARN", "");
    vi.stubEnv("AGENTCORE_BROWSER_ENABLED", "0");

    const { EGRESS_INVENTORY } = await import("@/lib/egress-inventory");
    expect([...new Set(hosts(EGRESS_INVENTORY))].sort()).toEqual([
      "*.force.com",
      "*.salesforce.com",
      "169.254.170.2",
      "bedrock-runtime.eu-west-1.amazonaws.com",
      "comparative.example",
      "ghe-mcp.example",
      "ghe.example",
      "logs.eu-west-1.amazonaws.com",
      "secretsmanager.eu-west-1.amazonaws.com",
      "test.salesforce.com",
    ]);
  });

  it("has no GitHub MCP row when GITHUB_MCP_URL is empty", async () => {
    vi.stubEnv("GITHUB_WEB_URL", undefined);
    vi.stubEnv("GITHUB_API_URL", undefined);
    vi.stubEnv("GITHUB_MCP_URL", "");
    const { EGRESS_INVENTORY } = await import("@/lib/egress-inventory");
    expect(hosts(EGRESS_INVENTORY)).toContain("api.github.com");
    expect(hosts(EGRESS_INVENTORY)).not.toContain("api.githubcopilot.com");
  });
});

describe("hosts the inventory can only mirror", () => {
  it("lists the Salesforce instance hosts the token check accepts", () => {
    for (const pattern of SALESFORCE_INSTANCE_HOSTS) {
      expect(
        isTrustedSalesforceInstanceUrl(`https://acme${pattern.slice(1)}`),
        pattern,
      ).toBe(true);
    }
    expect(isTrustedSalesforceInstanceUrl("https://acme.example")).toBe(false);
  });

  it("names the AgentCore endpoint the page's CSP allows", () => {
    const nextConfig = readFileSync(
      path.join(REPO_ROOT, "apps/web/next.config.mjs"),
      "utf8",
    );
    expect(nextConfig).toContain(
      "`bedrock-agentcore.${process.env.AWS_REGION ?? \"us-east-1\"}.amazonaws.com`",
    );
    expect(hosts(reference)).toContain(
      "bedrock-agentcore.<region>.amazonaws.com",
    );
  });
});

/**
 * A new `https://<host>` in shipped code is a new destination, so it has to be
 * in the inventory before this passes. The scan sees literal hosts only; a
 * host built from a variable (a region, a configured URL) is covered by the
 * inventory deriving from the same value.
 */
describe("https literals in shipped source", () => {
  /** Files that are not shipped code. */
  const NOT_SHIPPED: RegExp[] = [
    /\/(__tests__|__integration__|e2e)\//,
    /\.(test|spec)\./,
    // Eval cases and fixtures: prompts and canned tool results that name
    // sites the harness never contacts.
    /^packages\/evals\/src\/(cases|fixtures)\//,
  ];

  /** Hosts that are not destinations. Keep this short. */
  const IGNORED_HOSTS: Array<{ host: RegExp; reason: string }> = [
    {
      host: /(^|\.)example\.com$|\.(example|invalid|test)$/,
      reason:
        "reserved names (RFC 2606) that cannot resolve: URL-parsing bases and placeholders",
    },
    {
      host: /^docs\.aws\.amazon\.com$/,
      reason: "AWS documentation links in comments",
    },
  ];

  const LITERAL = /https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)/gi;

  function literalHosts(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    const files = execFileSync("git", ["ls-files", "-z", "apps", "packages"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter(
        (file) =>
          /\.(ts|tsx|mts|mjs|js|cjs)$/.test(file) &&
          !NOT_SHIPPED.some((pattern) => pattern.test(file)),
      );
    for (const file of files) {
      let source: string;
      try {
        source = readFileSync(path.join(REPO_ROOT, file), "utf8");
      } catch {
        continue; // deleted in the working tree
      }
      for (const match of source.matchAll(LITERAL)) {
        const host = match[1]!.toLowerCase();
        found.set(host, [...(found.get(host) ?? []), file]);
      }
    }
    return found;
  }

  const found = literalHosts();

  it("are all in the inventory or on the ignore list", () => {
    const unlisted = [...found]
      .filter(
        ([host]) =>
          !IGNORED_HOSTS.some((ignored) => ignored.host.test(host)) &&
          !hosts(reference).some((listed) => covers(listed, host)),
      )
      .map(([host, files]) => `${host} (${[...new Set(files)].join(", ")})`);
    expect(unlisted).toEqual([]);
  });

  it("still needs every ignore entry", () => {
    const unused = IGNORED_HOSTS.filter(
      (ignored) => ![...found.keys()].some((host) => ignored.host.test(host)),
    ).map((ignored) => ignored.reason);
    expect(unused).toEqual([]);
  });
});
