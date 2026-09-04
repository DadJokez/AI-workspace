import { assertPublicUrlAllowed } from "@ai-workspace/agent/public-url-policy";
import { closeDb, getDb } from "@ai-workspace/db";
import { createBrowserEgressProxy } from "@/lib/browser-egress-proxy";
import { loadWebEgressPolicy } from "@/lib/web-egress-policy";

const LISTEN_PORT = parsePort(process.env.BROWSER_PROXY_PORT ?? "3128");
const POLICY_CACHE_MS = 30_000;

let cachedPolicy:
  | { value: Awaited<ReturnType<typeof loadWebEgressPolicy>>; expiresAt: number }
  | undefined;

const server = createBrowserEgressProxy({
  username: requiredEnv("BROWSER_PROXY_USERNAME"),
  password: requiredEnv("BROWSER_PROXY_PASSWORD"),
  resolveTarget: async (url) => {
    const addresses = await assertPublicUrlAllowed({
      url,
      egressPolicy: await currentPolicy(),
    });
    // parsePublicHttpUrl already pinned the port to the scheme default.
    return { ...addresses[0]!, port: url.protocol === "https:" ? 443 : 80 };
  },
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      event: "browser_proxy_ready",
      port: LISTEN_PORT,
      policy: "public_http_https_only",
    }),
  );
});

async function currentPolicy() {
  const now = Date.now();
  if (cachedPolicy && cachedPolicy.expiresAt > now) return cachedPolicy.value;
  const value = await loadWebEgressPolicy(getDb());
  cachedPolicy = { value, expiresAt: now + POLICY_CACHE_MS };
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("BROWSER_PROXY_PORT must be a valid port.");
  }
  return port;
}

async function shutdown(signal: string) {
  console.log(JSON.stringify({ event: "browser_proxy_stopping", signal }));
  server.close();
  await closeDb();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
