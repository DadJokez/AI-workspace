/**
 * Child process for outbound-proxy.integration.test.ts. Node reads its proxy
 * settings at startup, so each outbound path is exercised in a fresh process.
 * Makes one call per path, each to its own host, and prints one JSON line per
 * probe. Whether a call was proxied is judged by the parent from what the proxy
 * recorded, not from anything printed here.
 */
import { createRequire } from "node:module";
import {
  BedrockAgentCoreClient,
  GetBrowserSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { connectMcpTools, RealBedrockClient } from "@ai-workspace/agent";
import { awsSdkProxyConfig } from "@ai-workspace/agent/outbound-proxy";
import { createWebFetchTool } from "@ai-workspace/agent/web-fetch-tool";
import { PostHog } from "posthog-node";

// NextAuth's OAuth/OIDC client. It is NextAuth's dependency, not ours.
const { Issuer } = createRequire(require.resolve("next-auth"))(
  "openid-client",
) as { Issuer: { discover(url: string): Promise<unknown> } };

const USER_TURN = [
  { role: "user" as const, content: [{ kind: "text" as const, text: "hi" }] },
];

const TOOL_CONTEXT = { userId: "outbound-proxy-probe" };

async function drain(stream: AsyncIterable<unknown>) {
  for await (const event of stream) void event;
}

const publicLookup = (async () => [
  { address: "93.184.216.34", family: 4 },
]) as never;
const privateLookup = (async () => [
  { address: "10.0.0.5", family: 4 },
]) as never;

const PROBES: Record<string, () => Promise<unknown>> = {
  fetch: () => fetch("https://fetch.stub.test/").then((res) => res.text()),
  "no-proxy": () =>
    fetch("https://noproxy.stub.test/").then((res) => res.text()),
  "web-fetch": () =>
    createWebFetchTool({ lookupImpl: publicLookup }).handler(
      { url: "https://webfetch.stub.test/page" },
      TOOL_CONTEXT,
    ),
  "web-fetch-private": () =>
    createWebFetchTool({ lookupImpl: privateLookup }).handler(
      { url: "https://private.stub.test/page" },
      TOOL_CONTEXT,
    ),
  "bedrock-converse": () =>
    drain(
      new RealBedrockClient().converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        supportsPromptCaching: false,
        messages: USER_TURN,
        maxTokens: 16,
      }),
    ),
  "bedrock-responses": () =>
    drain(
      new RealBedrockClient().converseStream({
        bedrockModelId: "us.openai.gpt-5.6-terra",
        supportsPromptCaching: false,
        invocation: "responses",
        messages: USER_TURN,
        maxTokens: 16,
      }),
    ),
  agentcore: () =>
    new BedrockAgentCoreClient({
      region: "us-east-1",
      maxAttempts: 1,
      ...awsSdkProxyConfig(),
    }).send(
      new GetBrowserSessionCommand({
        browserIdentifier: "probe-browser",
        sessionId: "probe-session",
      }),
    ),
  mcp: async () => {
    const connection = await connectMcpTools({
      probe: { url: "https://mcp.stub.test/mcp" },
    });
    if (connection.failedProviders.length > 0) {
      throw new Error(JSON.stringify(connection.failedProviders));
    }
  },
  oidc: () => Issuer.discover("https://oidc.stub.test"),
  posthog: async () => {
    const client = new PostHog("phc_probe", {
      host: "https://posthog.stub.test",
      flushAt: 1,
      flushInterval: 0,
    });
    client.capture({ distinctId: "probe", event: "probe" });
    await client.shutdown(5_000);
  },
};

function describeError(error: unknown): string {
  const parts: string[] = [];
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    const record = current as {
      message?: string;
      code?: string;
      address?: string;
      port?: number;
      cause?: unknown;
    };
    parts.push(
      [record.code, record.message, record.address, record.port]
        .filter((part) => part !== undefined && part !== "")
        .join(" "),
    );
    current = record.cause;
  }
  return parts.join(" <- ");
}

async function main() {
  for (const name of process.argv.slice(2)) {
    const probe = PROBES[name];
    if (!probe) throw new Error(`unknown probe ${name}`);
    let error: string | null = null;
    try {
      await probe();
    } catch (caught) {
      error = describeError(caught);
    }
    process.stdout.write(`${JSON.stringify({ name, error })}\n`);
  }
}

void main().then(() => process.exit(0));
