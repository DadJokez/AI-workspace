import https from "node:https";
import { NodeHttpHandler } from "@smithy/node-http-handler";

/**
 * Outbound HTTP through a forward proxy.
 *
 * Node does the work: started with `NODE_USE_ENV_PROXY=1`, global `fetch` and
 * the default `node:http(s)` agents route through `HTTPS_PROXY`/`HTTP_PROXY`
 * and bypass it for `NO_PROXY` hosts. That covers provider APIs, OAuth token
 * exchanges, the MCP client transport, NextAuth and analytics.
 *
 * It does not cover the AWS SDK. SDK clients build their own agent, and the
 * Bedrock runtime client speaks HTTP/2, which no proxy setting reaches. Every
 * SDK client therefore takes `awsSdkProxyConfig()`.
 *
 * With no proxy configured nothing here changes any request.
 */

type Env = Record<string, string | undefined>;

export type OutboundProxyDescription = {
  enabled: boolean;
  /** Host and port only. Never the credentials a proxy URL can carry. */
  proxyHost: string | null;
  noProxy: string[];
};

function proxyUrl(env: Env): string | undefined {
  return (
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
  )?.trim();
}

export function describeOutboundProxy(
  env: Env = process.env,
): OutboundProxyDescription {
  const raw = proxyUrl(env);
  let proxyHost: string | null = null;
  if (raw) {
    try {
      proxyHost = new URL(raw).host || null;
    } catch {
      proxyHost = null;
    }
  }
  return {
    enabled: proxyHost !== null && env.NODE_USE_ENV_PROXY === "1",
    proxyHost,
    noProxy: (env.NO_PROXY ?? env.no_proxy ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
  };
}

/**
 * Client config that sends an AWS SDK client through the proxy: spread it into
 * the constructor options. Empty when no proxy is enabled, so the client keeps
 * its default handler. `NO_PROXY` hosts (VPC endpoints) still connect directly.
 */
export function awsSdkProxyConfig(
  env: Env = process.env,
): { requestHandler?: NodeHttpHandler } {
  if (!describeOutboundProxy(env).enabled) return {};
  const agentOptions = { keepAlive: true, proxyEnv: env };
  return {
    requestHandler: new NodeHttpHandler({
      // `proxyEnv` is newer than the Node typings this workspace compiles with.
      httpsAgent: new https.Agent(agentOptions as https.AgentOptions),
    }),
  };
}

let logged = false;

/** One boot line saying whether outbound traffic uses a proxy. */
export function logOutboundProxyOnce(env: Env = process.env): void {
  if (logged) return;
  logged = true;
  const description = describeOutboundProxy(env);
  process.stderr.write(
    `[outbound-proxy] ${JSON.stringify({
      ...description,
      ...(description.proxyHost !== null && !description.enabled
        ? { inactive: "NODE_USE_ENV_PROXY is not 1; requests connect directly" }
        : {}),
    })}\n`,
  );
}
