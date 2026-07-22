import { createServer } from "node:http";
import {
  parseInvocationPayload,
  runInvocation,
  toSseFrame,
} from "./handler";
import {
  createAgentCoreApiKeyProvider,
  readWorkloadAccessToken,
} from "./agentcore-api-key";

/**
 * Amazon Bedrock AgentCore Runtime service contract
 * (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html):
 *
 *   GET  /ping         → {"status": "Healthy" | "HealthyBusy", "time_of_last_update": <unix seconds>}
 *   POST /invocations  → the agent invocation; we answer with text/event-stream
 *
 * Container requirements: listens on 8080, linux/arm64 image.
 */
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const MAX_BODY_BYTES = 10 * 1024 * 1024;

let activeInvocations = 0;
let lastUpdate = Math.floor(Date.now() / 1000);

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/ping")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: activeInvocations > 0 ? "HealthyBusy" : "Healthy",
        time_of_last_update: lastUpdate,
      }),
    );
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/invocations")) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readBody(req, MAX_BODY_BYTES));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: `Invalid JSON payload: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
      return;
    }

    let payload;
    try {
      payload = parseInvocationPayload(raw);
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }

    activeInvocations += 1;
    lastUpdate = Math.floor(Date.now() / 1000);

    const abort = new AbortController();
    req.on("close", () => abort.abort());

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    try {
      const providerName = process.env.BRAVE_SEARCH_CREDENTIAL_PROVIDER;
      await runInvocation(
        payload,
        (event) => {
          res.write(toSseFrame(event));
        },
        {
          signal: abort.signal,
          ...(providerName
            ? {
                webSearch: {
                  env: { WEB_SEARCH_PROVIDER: "brave" },
                  apiKeyProvider: createAgentCoreApiKeyProvider({
                    workloadAccessToken: readWorkloadAccessToken(req.headers),
                    providerName,
                    region:
                      process.env.AWS_REGION ??
                      process.env.AWS_DEFAULT_REGION,
                  }),
                },
              }
            : {}),
        },
      );
    } catch (err) {
      res.write(
        toSseFrame({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      activeInvocations -= 1;
      lastUpdate = Math.floor(Date.now() / 1000);
      res.end();
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

function readBody(
  req: import("node:http").IncomingMessage,
  limit: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Payload too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

server.listen(PORT, () => {
  process.stderr.write(
    `[agentcore-agent] listening on :${PORT} (POST /invocations, GET /ping)\n`,
  );
});
