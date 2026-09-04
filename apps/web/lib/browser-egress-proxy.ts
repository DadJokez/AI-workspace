import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import {
  parsePublicHttpUrl,
  type PublicAddress,
} from "@ai-workspace/agent/public-url-policy";

const SOCKET_TIMEOUT_MS = 15_000;
const MAX_HTTP_RESPONSE_BYTES = 10 * 1024 * 1024;
// The peer hung up (curl resets after reading a 403 status line, browsers
// abort navigations): nothing to recover, so these never escalate past debug.
const PEER_HANGUP_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED"]);

export type UpstreamTarget = PublicAddress & { port: number };

export type BrowserEgressProxyOptions = {
  username: string;
  password: string;
  /**
   * The allow/deny gate: returns where to dial for an allowed URL and throws
   * for a denied one (admin denylist, private address, unresolvable host).
   */
  resolveTarget: (url: URL) => Promise<UpstreamTarget>;
};

export function createBrowserEgressProxy({
  username,
  password,
  resolveTarget,
}: BrowserEgressProxyOptions): http.Server {
  const expectedCredentials = Buffer.from(`${username}:${password}`, "utf8");

  const server = http.createServer(async (req, res) => {
    if (
      !hasValidProxyAuthorization(
        req.headers["proxy-authorization"],
        expectedCredentials,
      )
    ) {
      proxyAuthRequired(res);
      return;
    }
    try {
      if (!req.url) throw new Error("missing_url");
      const url = parsePublicHttpUrl(req.url);
      if (url.protocol !== "http:") throw new Error("https_requires_connect");
      const target = await resolveTarget(url);
      const headers = sanitizeForwardHeaders(req.headers, url.host);
      const upstream = http.request(
        {
          protocol: "http:",
          hostname: target.address,
          family: target.family,
          port: target.port,
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
      upstream.on("error", (error) => {
        logSocketError("upstream", error);
        // Already answered, or the client is gone: nothing left to tell it.
        if (res.writableEnded || res.destroyed) return;
        if (!res.headersSent) res.writeHead(502);
        res.end("Proxy request failed.");
      });
      // A client that hangs up mid-transfer takes its upstream request with it.
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
      writeReceipt("allowed", url.hostname, "http", req.method ?? "GET");
    } catch (error) {
      writeReceipt(
        "denied",
        hostnameForReceipt(req.url),
        "http",
        req.method ?? "GET",
      );
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end(safeDenial(error));
    }
  });

  server.on("connect", async (req, socket, head) => {
    // @types/node widens this to Duplex; http.Server always hands us a net.Socket.
    const clientSocket = socket as net.Socket;
    let upstreamSocket: net.Socket | undefined;
    // Listen before the first write (#868): once 'connect' fires, Node has
    // detached its own error handling from this socket, so a client that
    // resets after reading a 403/407 is a normal hang-up here, not an
    // unhandled 'error' event that takes the process down.
    clientSocket.on("error", (error) => {
      logSocketError("client", error);
      upstreamSocket?.destroy();
    });
    // Whichever side finishes first, the other is flushed and released.
    clientSocket.on("close", () => upstreamSocket?.destroySoon());

    if (
      !hasValidProxyAuthorization(
        req.headers["proxy-authorization"],
        expectedCredentials,
      )
    ) {
      clientSocket.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Comparative Browser\"\r\n\r\n",
      );
      return;
    }
    let hostname = "unavailable";
    try {
      const authority = parseConnectAuthority(req.url ?? "");
      hostname = authority.hostname;
      const url = parsePublicHttpUrl(
        `https://${authority.hostname}:${authority.port}`,
      );
      const target = await resolveTarget(url);
      // The client gave up while the policy was deciding: nothing to tunnel.
      if (clientSocket.destroyed) return;
      const upstream = net.connect({
        host: target.address,
        family: target.family,
        port: target.port,
        timeout: SOCKET_TIMEOUT_MS,
      });
      upstreamSocket = upstream;
      upstream.once("connect", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
        writeReceipt("allowed", authority.hostname, "connect", "CONNECT");
      });
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", (error) => {
        logSocketError("upstream", error);
        clientSocket.destroy();
      });
      upstream.on("close", () => clientSocket.destroySoon());
    } catch (error) {
      writeReceipt("denied", hostname, "connect", "CONNECT");
      clientSocket.end(
        `HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n${safeDenial(error)}`,
      );
    }
  });

  return server;
}

function parseConnectAuthority(value: string): {
  hostname: string;
  port: number;
} {
  const url = new URL(`https://${value}`);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid_connect_authority");
  }
  const port = Number(url.port || "443");
  if (port !== 443) throw new Error("connect_port_denied");
  return { hostname: url.hostname, port };
}

function hasValidProxyAuthorization(
  value: string | string[] | undefined,
  expected: Buffer,
): boolean {
  if (typeof value !== "string" || !value.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(value.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
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

function logSocketError(
  peer: "client" | "upstream",
  error: NodeJS.ErrnoException,
) {
  const code = error.code ?? error.message;
  const line = JSON.stringify({ event: "browser_proxy_socket_error", peer, code });
  if (PEER_HANGUP_CODES.has(code)) console.debug(line);
  else console.warn(line);
}
