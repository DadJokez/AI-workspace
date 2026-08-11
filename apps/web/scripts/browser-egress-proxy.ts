import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import {
  assertPublicUrlAllowed,
  parsePublicHttpUrl,
} from "@ai-workspace/agent/public-url-policy";
import { closeDb, getDb } from "@ai-workspace/db";
import { loadWebEgressPolicy } from "@/lib/web-egress-policy";

const LISTEN_PORT = parsePort(process.env.BROWSER_PROXY_PORT ?? "3128");
const PROXY_USERNAME = requiredEnv("BROWSER_PROXY_USERNAME");
const PROXY_PASSWORD = requiredEnv("BROWSER_PROXY_PASSWORD");
const SOCKET_TIMEOUT_MS = 15_000;
const MAX_HTTP_RESPONSE_BYTES = 10 * 1024 * 1024;
const POLICY_CACHE_MS = 30_000;

let cachedPolicy:
  | { value: Awaited<ReturnType<typeof loadWebEgressPolicy>>; expiresAt: number }
  | undefined;

const server = http.createServer(async (req, res) => {
  if (!hasValidProxyAuthorization(req.headers["proxy-authorization"])) {
    proxyAuthRequired(res);
    return;
  }
  try {
    if (!req.url) throw new Error("missing_url");
    const url = parsePublicHttpUrl(req.url);
    if (url.protocol !== "http:") throw new Error("https_requires_connect");
    const addresses = await assertPublicUrlAllowed({
      url,
      egressPolicy: await currentPolicy(),
    });
    const address = addresses[0]!;
    const headers = sanitizeForwardHeaders(req.headers, url.host);
    const upstream = http.request(
      {
        protocol: "http:",
        hostname: address.address,
        family: address.family,
        port: 80,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        timeout: SOCKET_TIMEOUT_MS,
      },
      (upstreamResponse) => {
        res.writeHead(
          upstreamResponse.statusCode ?? 502,
          sanitizeResponseHeaders(upstreamResponse.headers),
        );
        let bytes = 0;
        upstreamResponse.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_HTTP_RESPONSE_BYTES) {
            upstreamResponse.destroy(new Error("response_too_large"));
            res.destroy();
          }
        });
        upstreamResponse.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("Proxy request failed.");
    });
    req.pipe(upstream);
    writeReceipt("allowed", url.hostname, "http", req.method ?? "GET");
  } catch (error) {
    writeReceipt("denied", hostnameForReceipt(req.url), "http", req.method ?? "GET");
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end(safeDenial(error));
  }
});

server.on("connect", async (req, clientSocket, head) => {
  if (!hasValidProxyAuthorization(req.headers["proxy-authorization"])) {
    clientSocket.end(
      "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Comparative Browser\"\r\n\r\n",
    );
    return;
  }
  let hostname = "unavailable";
  try {
    const authority = parseConnectAuthority(req.url ?? "");
    hostname = authority.hostname;
    const url = parsePublicHttpUrl(`https://${authority.hostname}:${authority.port}`);
    const addresses = await assertPublicUrlAllowed({
      url,
      egressPolicy: await currentPolicy(),
    });
    const address = addresses[0]!;
    const upstreamSocket = net.connect({
      host: address.address,
      family: address.family,
      port: authority.port,
      timeout: SOCKET_TIMEOUT_MS,
    });
    upstreamSocket.once("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      writeReceipt("allowed", authority.hostname, "connect", "CONNECT");
    });
    upstreamSocket.on("timeout", () => upstreamSocket.destroy());
    upstreamSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstreamSocket.destroy());
  } catch (error) {
    writeReceipt("denied", hostname, "connect", "CONNECT");
    clientSocket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n${safeDenial(error)}`);
  }
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

function parseConnectAuthority(value: string): { hostname: string; port: number } {
  const url = new URL(`https://${value}`);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("invalid_connect_authority");
  }
  const port = Number(url.port || "443");
  if (port !== 443) throw new Error("connect_port_denied");
  return { hostname: url.hostname, port };
}

function hasValidProxyAuthorization(value: string | string[] | undefined): boolean {
  if (typeof value !== "string" || !value.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(value.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const expected = Buffer.from(`${PROXY_USERNAME}:${PROXY_PASSWORD}`, "utf8");
  const supplied = Buffer.from(decoded, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function proxyAuthRequired(res: http.ServerResponse) {
  res.writeHead(407, {
    "proxy-authenticate": 'Basic realm="Comparative Browser"',
    "content-type": "text/plain; charset=utf-8",
  });
  res.end("Proxy authentication required.");
}

function sanitizeForwardHeaders(
  headers: http.IncomingHttpHeaders,
  host: string,
): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  const blocked = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "cookie",
    "authorization",
  ]);
  for (const [name, value] of Object.entries(headers)) {
    if (!blocked.has(name.toLowerCase()) && value !== undefined) result[name] = value;
  }
  result.host = host;
  return result;
}

function sanitizeResponseHeaders(
  headers: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  const blocked = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "set-cookie",
  ]);
  for (const [name, value] of Object.entries(headers)) {
    if (!blocked.has(name.toLowerCase()) && value !== undefined) result[name] = value;
  }
  result["cache-control"] = "private, no-store";
  result["referrer-policy"] = "no-referrer";
  return result;
}

function hostnameForReceipt(value: string | undefined): string {
  try {
    return value ? new URL(value).hostname : "unavailable";
  } catch {
    return "unavailable";
  }
}

function safeDenial(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.includes("web_egress_denied")
    ? "Blocked by workspace web policy."
    : "This network target is not permitted.";
}

function writeReceipt(
  decision: "allowed" | "denied",
  hostname: string,
  transport: "http" | "connect",
  method: string,
) {
  console.log(
    JSON.stringify({
      event: "browser_proxy_request",
      decision,
      hostname: hostname.toLowerCase().replace(/\.$/, ""),
      transport,
      method,
    }),
  );
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
