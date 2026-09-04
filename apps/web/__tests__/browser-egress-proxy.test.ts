import * as http from "node:http";
import * as net from "node:net";
import {
  WEB_EGRESS_POLICY_NAME,
  assertWebEgressAllowed,
  type WebEgressPolicy,
} from "@ai-workspace/agent/web-egress-policy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserEgressProxy,
  type UpstreamTarget,
} from "@/lib/browser-egress-proxy";

const USERNAME = "studio";
const PASSWORD = "tunnel-secret";
const PROXY_AUTH = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;
const ALLOWED_HOST = "allowed.example";
const DENIED_HOST = "denied.example";
const POLICY: WebEgressPolicy = {
  name: WEB_EGRESS_POLICY_NAME,
  deniedDomains: [DENIED_HOST],
};

const cleanup: Array<() => Promise<void> | void> = [];
const logs = { log: [] as string[], debug: [] as string[], warn: [] as string[] };

beforeEach(() => {
  for (const level of ["log", "debug", "warn"] as const) {
    logs[level] = [];
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs[level].push(String(args[0]));
    });
  }
});

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.restoreAllMocks();
});

describe("browser egress proxy", () => {
  it("survives a client that resets the socket after a denied CONNECT", async () => {
    const upstream = await startTcpUpstream();
    const proxy = await startProxy(policyResolver(upstream.port));

    const serverSide = proxy.nextConnection();
    const client = await openClient(proxy.port);
    client.socket.write(connectRequest(DENIED_HOST));
    const response = await client.waitFor("Blocked by workspace web policy.");
    expect(response.startsWith("HTTP/1.1 403 Forbidden\r\n")).toBe(true);

    // curl closes with the denial body unread, so the kernel sends RST.
    client.socket.resetAndDestroy();
    await closed(await serverSide);

    expect(logs.log).toEqual([receipt("denied", DENIED_HOST, "connect")]);
    expect(logs.debug).toEqual([
      JSON.stringify({
        event: "browser_proxy_socket_error",
        peer: "client",
        code: "ECONNRESET",
      }),
    ]);
    expect(logs.warn).toEqual([]);

    // Still listening and still tunnelling for the next session.
    await expectTunnel(proxy.port);
    expect(logs.log).toContain(receipt("allowed", ALLOWED_HOST, "connect"));
  });

  it("skips the upstream dial when the client resets before the decision lands", async () => {
    const upstream = await startTcpUpstream();
    let decide!: () => void;
    const decision = new Promise<void>((resolve) => (decide = resolve));
    const resolveTarget = vi.fn(async (url: URL) => {
      await decision;
      return policyResolver(upstream.port)(url);
    });
    const proxy = await startProxy(resolveTarget);

    const serverSide = proxy.nextConnection();
    const client = await openClient(proxy.port);
    client.socket.write(connectRequest(ALLOWED_HOST));
    await vi.waitFor(() => expect(resolveTarget).toHaveBeenCalledTimes(1));
    client.socket.resetAndDestroy();
    await closed(await serverSide);
    decide();

    await expectTunnel(proxy.port);
    // Only the follow-up session reached the upstream.
    expect(upstream.connections).toHaveLength(1);
    expect(logs.log).toEqual([receipt("allowed", ALLOWED_HOST, "connect")]);
    expect(logs.debug).toEqual([
      JSON.stringify({
        event: "browser_proxy_socket_error",
        peer: "client",
        code: "ECONNRESET",
      }),
    ]);
  });

  it("releases the upstream when a tunnelled client resets mid-stream", async () => {
    const upstream = await startTcpUpstream((socket) => {
      socket.write("banner");
    });
    const proxy = await startProxy(policyResolver(upstream.port));

    const client = await openClient(proxy.port);
    client.socket.write(connectRequest(ALLOWED_HOST));
    await client.waitFor("banner");
    const upstreamSide = upstream.connections[0]!;

    client.socket.resetAndDestroy();
    await closed(upstreamSide);

    await expectTunnel(proxy.port);
    expect(logs.warn).toEqual([]);
  });

  it("releases the upstream when a plain-HTTP client resets mid-response", async () => {
    const upstream = await startHttpUpstream();
    const proxy = await startProxy(policyResolver(upstream.port));

    const client = await openClient(proxy.port);
    client.socket.write(
      `GET http://${ALLOWED_HOST}/stream HTTP/1.1\r\nHost: ${ALLOWED_HOST}\r\nProxy-Authorization: ${PROXY_AUTH}\r\n\r\n`,
    );
    await client.waitFor("first chunk");
    const upstreamSide = upstream.connections[0]!;

    client.socket.resetAndDestroy();
    await closed(upstreamSide);

    // Still serving: the follow-up request completes normally.
    const response = await proxiedRequest(proxy.port, `http://${ALLOWED_HOST}/page`);
    expect(response.status).toBe(200);
    expect(logs.log).toEqual([
      receipt("allowed", ALLOWED_HOST, "http", "GET"),
      receipt("allowed", ALLOWED_HOST, "http", "GET"),
    ]);
    expect(logs.warn).toEqual([]);
  });

  it("tunnels an allowed CONNECT exactly as before", async () => {
    const proxy = await startProxy(policyResolver((await startTcpUpstream()).port));
    await expectTunnel(proxy.port);
    expect(logs.log).toEqual([receipt("allowed", ALLOWED_HOST, "connect")]);
    expect(logs.debug).toEqual([]);
    expect(logs.warn).toEqual([]);
  });

  it("forwards an allowed plain-HTTP request and sanitizes the response", async () => {
    const upstream = await startHttpUpstream();
    const proxy = await startProxy(policyResolver(upstream.port));

    const response = await proxiedRequest(proxy.port, `http://${ALLOWED_HOST}/page`);
    expect(response.status).toBe(200);
    expect(response.body).toBe("hello over http");
    expect(response.headers["x-upstream"]).toBe("yes");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(upstream.requests[0]).toMatchObject({
      url: "/page",
      host: ALLOWED_HOST,
      proxyAuthorization: undefined,
    });
    expect(logs.log).toEqual([receipt("allowed", ALLOWED_HOST, "http", "GET")]);
  });

  it("denies plain-HTTP requests with a 403 and a denied receipt", async () => {
    const upstream = await startHttpUpstream();
    const proxy = await startProxy(policyResolver(upstream.port));

    const response = await proxiedRequest(proxy.port, `http://${DENIED_HOST}/page`);
    expect(response.status).toBe(403);
    expect(response.body).toBe("Blocked by workspace web policy.");
    expect(upstream.requests).toEqual([]);
    expect(logs.log).toEqual([receipt("denied", DENIED_HOST, "http", "GET")]);
  });

  it("requires proxy credentials on both transports", async () => {
    const proxy = await startProxy(policyResolver((await startTcpUpstream()).port));

    const response = await proxiedRequest(proxy.port, `http://${ALLOWED_HOST}/`, {
      auth: false,
    });
    expect(response.status).toBe(407);
    expect(response.headers["proxy-authenticate"]).toBe(
      'Basic realm="Comparative Browser"',
    );

    const client = await openClient(proxy.port);
    client.socket.write(`CONNECT ${ALLOWED_HOST}:443 HTTP/1.1\r\nHost: ${ALLOWED_HOST}:443\r\n\r\n`);
    const { head } = await readHead(client);
    expect(head.startsWith("HTTP/1.1 407 Proxy Authentication Required\r\n")).toBe(true);
    expect(logs.log).toEqual([]);
  });
});

function policyResolver(upstreamPort: number) {
  return async (url: URL): Promise<UpstreamTarget> => {
    assertWebEgressAllowed(url.hostname, POLICY);
    return { address: "127.0.0.1", family: 4, port: upstreamPort };
  };
}

function receipt(
  decision: "allowed" | "denied",
  hostname: string,
  transport: "http" | "connect",
  method = "CONNECT",
) {
  return JSON.stringify({
    event: "browser_proxy_request",
    decision,
    hostname,
    transport,
    method,
  });
}

function connectRequest(hostname: string) {
  return `CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\nProxy-Authorization: ${PROXY_AUTH}\r\n\r\n`;
}

async function startProxy(resolveTarget: (url: URL) => Promise<UpstreamTarget>) {
  const server = createBrowserEgressProxy({
    username: USERNAME,
    password: PASSWORD,
    resolveTarget,
  });
  const { port } = await listen(server);
  return {
    port,
    nextConnection: () =>
      new Promise<net.Socket>((resolve) => server.once("connection", resolve)),
  };
}

async function startTcpUpstream(onConnection?: (socket: net.Socket) => void) {
  const server = net.createServer((socket) => {
    onConnection?.(socket);
    socket.on("data", (chunk) => socket.write(chunk));
  });
  return listen(server);
}

async function startHttpUpstream() {
  const requests: Array<{
    url: string | undefined;
    host: string | undefined;
    proxyAuthorization: string | undefined;
  }> = [];
  const server = http.createServer((req, res) => {
    requests.push({
      url: req.url,
      host: req.headers.host,
      proxyAuthorization: req.headers["proxy-authorization"],
    });
    if (req.url === "/stream") {
      // Headers plus one chunk, then hold the response open.
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first chunk");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/plain",
      "set-cookie": "session=secret",
      "x-upstream": "yes",
    });
    res.end("hello over http");
  });
  return { ...(await listen(server)), requests };
}

/** Binds an ephemeral port and tears the server (and its sockets) down after the test. */
async function listen(server: net.Server) {
  const connections: net.Socket[] = [];
  server.on("connection", (socket: net.Socket) => connections.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server failed to bind.");
  }
  return { port: address.port, connections };
}

async function openClient(port: number) {
  const socket = net.connect({ host: "127.0.0.1", port });
  cleanup.push(() => {
    socket.destroy();
  });
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  let received = "";
  let waiters: Array<{ text: string; resolve: (value: string) => void }> = [];
  socket.on("data", (chunk: Buffer) => {
    received += chunk.toString("latin1");
    waiters = waiters.filter((waiter) => {
      if (!received.includes(waiter.text)) return true;
      waiter.resolve(received);
      return false;
    });
  });
  return {
    socket,
    waitFor: (text: string) =>
      new Promise<string>((resolve) => {
        if (received.includes(text)) resolve(received);
        else waiters.push({ text, resolve });
      }),
  };
}

/**
 * Opens a CONNECT tunnel to the echo upstream and round-trips a payload.
 *
 * Only the CONNECT response head is asserted: once the proxy has spliced the
 * sockets, anything the upstream writes on connect can coalesce onto the same
 * TCP read as the "200 Connection Established" bytes. Those trailing bytes are
 * tunnel data, not part of the proxy's response, so they are returned rather
 * than compared.
 */
async function expectTunnel(proxyPort: number) {
  const client = await openClient(proxyPort);
  client.socket.write(connectRequest(ALLOWED_HOST));
  const { head, rest } = await readHead(client);
  expect(head).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
  client.socket.write("ping through the tunnel");
  await client.waitFor("ping through the tunnel");
  client.socket.end();
  return rest;
}

/** Reads through the header terminator; `rest` is any tunnel data received with it. */
async function readHead(client: Awaited<ReturnType<typeof openClient>>) {
  const received = await client.waitFor("\r\n\r\n");
  const end = received.indexOf("\r\n\r\n") + 4;
  return { head: received.slice(0, end), rest: received.slice(end) };
}

function closed(socket: net.Socket) {
  return new Promise<void>((resolve) => {
    if (socket.closed) resolve();
    else socket.once("close", () => resolve());
  });
}

function proxiedRequest(
  proxyPort: number,
  url: string,
  { auth = true }: { auth?: boolean } = {},
) {
  return new Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: url,
        agent: false,
        headers: {
          host: new URL(url).host,
          ...(auth ? { "proxy-authorization": PROXY_AUTH } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}
