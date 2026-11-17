import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/**
 * Node's proxy support (NODE_USE_ENV_PROXY) does not reach AWS SDK clients, so
 * each one must take `awsSdkProxyConfig()` (packages/agent/src/outbound-proxy.ts).
 * A client or MCP transport built anywhere else would bypass the proxy
 * silently, so new construction sites have to be added here on purpose.
 */
const AWS_CLIENT_SITES: Record<string, { proxied: boolean }> = {
  "packages/agent/src/clients.ts": { proxied: true },
  "packages/agent-runtime/src/agentcore-runtime.ts": { proxied: true },
  "apps/agentcore-agent/src/agentcore-api-key.ts": { proxied: true },
  "apps/web/lib/studio-browser.ts": { proxied: true },
  // Signs requests only; the request itself goes out through global fetch.
  "packages/agent/src/responses-client.ts": { proxied: false },
};
const MCP_TRANSPORT_SITES = ["packages/agent/src/mcp.ts"];

const AWS_CLIENT = /\bnew\s+\w+Client\s*\(/;
const AWS_IMPORT = /from\s+["']@aws-sdk\/client-/;
const MCP_TRANSPORT = /\bnew\s+\w*ClientTransport\s*\(/;

function sourceFiles(): Array<{ file: string; source: string }> {
  return execFileSync("git", ["ls-files", "-z", "apps", "packages"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(
      (file) =>
        /\.(ts|tsx|mts|mjs)$/.test(file) &&
        !/\/(__tests__|__integration__|e2e)\//.test(file) &&
        !/\.(test|spec)\./.test(file),
    )
    .flatMap((file) => {
      try {
        return [
          { file, source: readFileSync(path.join(REPO_ROOT, file), "utf8") },
        ];
      } catch {
        return []; // deleted in the working tree
      }
    });
}

describe("outbound proxy call sites", () => {
  const files = sourceFiles();

  it("builds AWS SDK clients only at the known sites", () => {
    const sites = files
      .filter(({ source }) => AWS_IMPORT.test(source) && AWS_CLIENT.test(source))
      .map(({ file }) => file)
      .sort();
    expect(sites).toEqual(Object.keys(AWS_CLIENT_SITES).sort());
  });

  it("passes the proxy config to every AWS SDK client that sends requests", () => {
    const missing = files
      .filter(({ file }) => AWS_CLIENT_SITES[file]?.proxied)
      .filter(({ source }) => !source.includes("...awsSdkProxyConfig()"))
      .map(({ file }) => file);
    expect(missing).toEqual([]);
  });

  it("builds MCP client transports only at the known sites", () => {
    const sites = files
      .filter(({ source }) => MCP_TRANSPORT.test(source))
      .map(({ file }) => file)
      .sort();
    expect(sites).toEqual(MCP_TRANSPORT_SITES);
  });
});
