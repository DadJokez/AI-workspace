import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Koch migration WP-03: inside the firewall every non-AWS destination is
 * reachable only through a forward proxy. This suite stands up a recording
 * CONNECT proxy and a local HTTPS stub (never the internet), then runs one
 * call per outbound path in a child process started the way production is:
 * NODE_USE_ENV_PROXY=1 plus HTTPS_PROXY / HTTP_PROXY / NO_PROXY.
 *
 * No probe host resolves, so a call that skips the proxy cannot succeed by
 * accident.
 */

const PROBE = path.resolve(__dirname, "fixtures/outbound-proxy-probe.ts");

/** probe name -> the host the proxy must see a CONNECT for. */
const PROXIED_PROBES: Record<string, string> = {
  fetch: "fetch.stub.test",
  "web-fetch": "webfetch.stub.test",
  "bedrock-converse": "bedrock.stub.test",
  "bedrock-responses": "bedrock-runtime.us-east-1.amazonaws.com",
  agentcore: "agentcore.stub.test",
  mcp: "mcp.stub.test",
  oidc: "oidc.stub.test",
  posthog: "posthog.stub.test",
};

type ProbeResult = { name: string; error: string | null };

let workDir: string;
let stub: https.Server;
let proxy: http.Server;
let proxyPort: number;
const connects: string[] = [];

function generateCertificates(dir: string) {
  const openssl = (...args: string[]) =>
    execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  openssl(
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=outbound-proxy-test-ca",
  );
  openssl(
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", "stub.key", "-out", "stub.csr", "-subj", "/CN=stub.test",
  );
  writeFileSync(path.join(dir, "san.cnf"), "subjectAltName=DNS:*.stub.test\n");
  openssl(
    "x509", "-req", "-in", "stub.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
    "-CAcreateserial", "-days", "2", "-extfile", "san.cnf", "-out", "stub.crt",
  );
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );
}

function runProbes(
  probes: string[],
  env: Record<string, string>,
): Promise<Map<string, ProbeResult>> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", PROBE, ...probes],
      {
        cwd: path.resolve(__dirname, ".."),
        timeout: 60_000,
        // A clean environment: the machine running the suite may itself sit
        // behind a proxy.
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH ?? "",
          NODE_EXTRA_CA_CERTS: path.join(workDir, "ca.crt"),
          AWS_REGION: "us-east-1",
          AWS_ACCESS_KEY_ID: "AKIAOUTBOUNDPROXYTEST",
          AWS_SECRET_ACCESS_KEY: "outbound-proxy-test",
          AWS_MAX_ATTEMPTS: "1",
          AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "https://bedrock.stub.test",
          AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: "https://agentcore.stub.test",
          ...env,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`probe process failed: ${error.message}\n${stderr}`));
          return;
        }
        const results = stdout
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line) as ProbeResult);
        resolve(new Map(results.map((result) => [result.name, result])));
      },
    );
  });
}

function proxyEnv(port: number): Record<string, string> {
  return {
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: `http://127.0.0.1:${port}`,
    HTTP_PROXY: `http://127.0.0.1:${port}`,
    NO_PROXY: "noproxy.stub.test",
  };
}

beforeAll(async () => {
  workDir = mkdtempSync(path.join(os.tmpdir(), "outbound-proxy-"));
  generateCertificates(workDir);

  stub = https.createServer(
    {
      key: readFileSync(path.join(workDir, "stub.key")),
      cert: readFileSync(path.join(workDir, "stub.crt")),
    },
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
  );
  const stubPort = await listen(stub);

  // Records every CONNECT and tunnels it to the stub, whatever host was asked.
  proxy = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  proxy.on("connect", (req, clientSocket) => {
    connects.push((req.url ?? "").split(":")[0]!);
    const upstream = net.connect(stubPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  proxyPort = await listen(proxy);
}, 60_000);

afterAll(async () => {
  proxy?.closeAllConnections();
  stub?.closeAllConnections();
  await Promise.all(
    [proxy, stub].map(
      (server) => new Promise((resolve) => (server ? server.close(resolve) : resolve(null))),
    ),
  );
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("outbound HTTP through a forward proxy (WP-03)", () => {
  it("sends every outbound path through the proxy", async () => {
    connects.length = 0;
    const results = await runProbes(
      Object.keys(PROXIED_PROBES),
      proxyEnv(proxyPort),
    );

    const unproxied = Object.entries(PROXIED_PROBES)
      .filter(([, host]) => !connects.includes(host))
      .map(([name]) => `${name}: ${results.get(name)?.error ?? "no error"}`);
    expect(unproxied).toEqual([]);

    // These get a well-formed answer from the stub, so they must also succeed.
    for (const name of ["fetch", "web-fetch", "oidc", "posthog"]) {
      expect(results.get(name), name).toEqual({ name, error: null });
    }
  }, 90_000);

  it("connects directly to a NO_PROXY host", async () => {
    connects.length = 0;
    const results = await runProbes(["no-proxy"], proxyEnv(proxyPort));

    expect(connects).not.toContain("noproxy.stub.test");
    // Nothing resolves that name, so the direct attempt fails in DNS.
    expect(results.get("no-proxy")?.error).toMatch(/ENOTFOUND/);
  }, 60_000);

  it("refuses a private address before the proxy is contacted", async () => {
    connects.length = 0;
    const results = await runProbes(
      ["web-fetch-private"],
      proxyEnv(proxyPort),
    );

    expect(connects).toEqual([]);
    expect(results.get("web-fetch-private")?.error).toBeTruthy();
  }, 60_000);

  it("makes no use of the proxy unless Node was started with NODE_USE_ENV_PROXY", async () => {
    connects.length = 0;
    const { NODE_USE_ENV_PROXY: _flag, ...withoutFlag } = proxyEnv(proxyPort);
    const results = await runProbes(
      ["fetch", "bedrock-converse", "agentcore"],
      withoutFlag,
    );

    expect(connects).toEqual([]);
    for (const name of ["fetch", "bedrock-converse", "agentcore"]) {
      expect(results.get(name)?.error, name).toMatch(/ENOTFOUND/);
    }
  }, 60_000);

  it("fails with an error that names the proxy when the proxy is down", async () => {
    const closed = net.createServer();
    const deadPort = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));

    const results = await runProbes(
      ["fetch", "web-fetch", "bedrock-converse", "agentcore"],
      proxyEnv(deadPort),
    );

    for (const name of ["fetch", "web-fetch", "bedrock-converse", "agentcore"]) {
      expect(results.get(name)?.error, name).toContain(String(deadPort));
    }
  }, 60_000);
});
