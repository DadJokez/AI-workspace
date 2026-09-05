#!/usr/bin/env node
/**
 * Pilot-row load test for Comparative (#696) — Node stdlib only.
 *
 * Measures the docs/ENTERPRISE_READINESS.md "Load-Test Model" pilot row
 * against a running web server:
 *
 *   health  GET  /api/health at 50 concurrent, closed loop, for --duration s
 *   chat    POST /api/chat plain no-tool turns at 25 concurrent for --duration s,
 *           rotating through --users seeded synthetic users (the limiter is
 *           30 turns / 60 s PER USER) and consuming each SSE stream to its
 *           terminal event
 *   burst   --burst-requests POST /api/chat from ONE user at 50 concurrent so
 *           the Postgres fixed-window limiter trips; every 10th body is an
 *           oversized message (413). Verifies 429 + Retry-After, no 5xx, and
 *           (with --db-url) no connection exhaustion
 *
 * Model cost: with BEDROCK_CLIENT=fake (the mode the CI smoke lanes use) the
 * turn never reaches Bedrock, so this measures app + Postgres, not model
 * latency. The report says how many accepted turns answered with the fake
 * client's "[fake]" prefix so a run against a real-model server is obvious.
 *
 * Auth: mints NextAuth v4 session cookies the same way `next-auth/jwt`
 * `encode` does (HKDF-SHA256 of NEXTAUTH_SECRET → dir/A256GCM JWE), one per
 * synthetic user, so no credentials are stored anywhere. Seed the users
 * first:  pnpm --filter @ai-workspace/web seed:load-users
 * Or pass --cookie <session-token> to run every scenario as one existing
 * session (chat will then hit the per-user limiter — fine for health/burst).
 *
 * Local run (mirrors the authenticated-smoke lane's server env):
 *   DATABASE_URL=postgres://aihub:aihub_dev@localhost:5432/aihub \
 *     pnpm --filter @ai-workspace/db db:migrate && \
 *     pnpm --filter @ai-workspace/web seed:load-users
 *   pnpm build
 *   (cd apps/web && E2E_TEST_MODE=1 BEDROCK_CLIENT=fake CHAT_RUN_IN_PROCESS_WORKER=1 \
 *     MEMORY_CAPTURE_IN_PROCESS_SCHEDULER=0 NEXTAUTH_URL=http://127.0.0.1:3000 \
 *     NEXTAUTH_SECRET=playwright-local-secret-with-enough-length \
 *     OAUTH_ENCRYPTION_KEY=playwright-oauth-encryption-key-at-least-32-characters \
 *     GITHUB_WEBHOOK_SECRET=x GITHUB_AUTH_CLIENT_ID=x GITHUB_AUTH_CLIENT_SECRET=x \
 *     AWS_REGION=us-east-1 DATABASE_URL=postgres://aihub:aihub_dev@localhost:5432/aihub \
 *     pnpm exec next start --hostname 127.0.0.1 --port 3000)
 *   node scripts/load/pilot-load.mjs --db-url postgres://aihub:aihub_dev@localhost:5432/aihub
 *
 * Output: a table + threshold verdicts on stdout and a JSON file under
 * tmp/load/ (gitignored). Threshold failures are reported, not fatal; the
 * exit code is non-zero only when the run itself could not complete.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import {
  LATENCY_HEADERS,
  evaluateThresholds,
  formatTable,
  latencyRows,
  scenarioReport,
} from "./stats.mjs";
import { deriveEncryptionKey, mintSessionToken, sessionCookie } from "./session.mjs";
import { loadUser } from "./users.mjs";

const execFileAsync = promisify(execFile);

const DEFAULTS = {
  "base-url": process.env.LOAD_BASE_URL ?? "http://127.0.0.1:3000",
  scenarios: "health,chat,burst",
  duration: 60,
  "health-concurrency": 50,
  "chat-concurrency": 25,
  "burst-concurrency": 50,
  "burst-requests": 300,
  users: 1000,
  "turns-per-thread": 8,
  "turn-timeout": 30_000,
  warmup: 5,
  "db-url": process.env.LOAD_DB_URL ?? "",
  cookie: process.env.LOAD_SESSION_TOKEN ?? "",
  secret: process.env.NEXTAUTH_SECRET ?? "",
  out: "",
};
// Same non-secret default as apps/web/playwright.config.ts; only ever used
// for loopback targets.
const PLAYWRIGHT_LOCAL_SECRET = "playwright-local-secret-with-enough-length";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CHAT_MAX_MESSAGE_CHARS = 24_000; // CHAT_MAX_MESSAGE_CHARS default in request-limits.ts
const FAKE_PREFIX = "[fake]"; // FakeBedrockClient responsePrefix, packages/agent/src/clients.ts

function usage() {
  return `Usage: node scripts/load/pilot-load.mjs [options]

  --base-url <url>            target (default ${DEFAULTS["base-url"]}; env LOAD_BASE_URL)
  --scenarios <list>          comma list of health,chat,burst (default all)
  --duration <s>              health/chat run length (default ${DEFAULTS.duration})
  --health-concurrency <n>    default ${DEFAULTS["health-concurrency"]}
  --chat-concurrency <n>      default ${DEFAULTS["chat-concurrency"]}
  --burst-concurrency <n>     default ${DEFAULTS["burst-concurrency"]}
  --burst-requests <n>        default ${DEFAULTS["burst-requests"]}
  --users <n>                 seeded load users to rotate through (default ${DEFAULTS.users})
  --turns-per-thread <n>      chat turns before a user starts a new thread (default ${DEFAULTS["turns-per-thread"]})
  --turn-timeout <ms>         per-request abort (default ${DEFAULTS["turn-timeout"]})
  --warmup <n>                sequential requests discarded before each scenario (default ${DEFAULTS.warmup})
  --db-url <postgres url>     sample pg_stat_activity via psql during each scenario (env LOAD_DB_URL)
  --cookie <session token>    use one existing next-auth session instead of minting (env LOAD_SESSION_TOKEN)
  --secret <NEXTAUTH_SECRET>  secret to mint sessions with (env NEXTAUTH_SECRET; loopback targets default to the playwright local secret)
  --out <file>                JSON report path (default tmp/load/pilot-load-<timestamp>.json)
  --help`;
}

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!(key in DEFAULTS)) throw new Error(`unknown option --${key}\n\n${usage()}`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`--${key} needs a value`);
    out[key] = typeof DEFAULTS[key] === "number" ? Number(value) : value;
    if (typeof DEFAULTS[key] === "number" && !(out[key] > 0)) {
      throw new Error(`--${key} must be a positive number`);
    }
  }
  return out;
}

// --- identities -----------------------------------------------------------

function buildIdentities(args, baseUrl) {
  if (args.cookie) {
    return {
      mode: "one provided session (--cookie)",
      identities: [{ label: "provided-session", cookie: sessionCookie(baseUrl, args.cookie) }],
    };
  }
  let secret = args.secret;
  if (!secret) {
    if (!LOOPBACK.has(baseUrl.hostname)) {
      throw new Error(
        "NEXTAUTH_SECRET (or --secret / --cookie) is required for a non-loopback target; never guess a production secret.",
      );
    }
    secret = PLAYWRIGHT_LOCAL_SECRET;
  }
  const key = deriveEncryptionKey(secret);
  const identities = Array.from({ length: args.users }, (_, i) => {
    const user = loadUser(i);
    return { label: user.pingSubject, id: user.id, cookie: sessionCookie(baseUrl, mintSessionToken(key, user)) };
  });
  return { mode: `${identities.length} minted sessions for seeded load users`, identities };
}

// --- HTTP ----------------------------------------------------------------

function errorName(err) {
  if (err && typeof err === "object" && "name" in err) {
    const cause = err.cause && typeof err.cause === "object" && "code" in err.cause ? `:${err.cause.code}` : "";
    return `${err.name}${cause}`;
  }
  return String(err);
}

async function healthRequest({ baseUrl, timeoutMs }) {
  const t0 = performance.now();
  try {
    const res = await fetch(new URL("/api/health", baseUrl), {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ttfbMs = performance.now() - t0;
    const text = await res.text();
    const totalMs = performance.now() - t0;
    let dbLatencyMs;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.checks?.db?.latencyMs === "number") dbLatencyMs = parsed.checks.db.latencyMs;
    } catch {
      // non-JSON body: recorded by status only
    }
    return { status: res.status, ttfbMs, totalMs, dbLatencyMs };
  } catch (err) {
    return { status: null, error: errorName(err), totalMs: performance.now() - t0 };
  }
}

/** One chat turn: POST, then drain the SSE stream to its terminal event. */
async function chatTurn({ baseUrl, timeoutMs, identity, body }) {
  const t0 = performance.now();
  const sample = { status: null, totalMs: 0 };
  try {
    const res = await fetch(new URL("/api/chat", baseUrl), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", cookie: identity.cookie },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    sample.status = res.status;
    sample.ttfbMs = performance.now() - t0;
    sample.retryAfter = res.headers.get("retry-after");
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      await res.arrayBuffer();
      sample.totalMs = performance.now() - t0;
      return sample;
    }
    const decoder = new TextDecoder();
    let buffered = "";
    let leadingText = "";
    for await (const chunk of res.body) {
      buffered += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffered.indexOf("\n\n")) !== -1) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (sample.firstEventMs === undefined) sample.firstEventMs = performance.now() - t0;
        if (event.type === "meta" && typeof event.threadId === "string") sample.threadId = event.threadId;
        if (event.type === "text-delta" && leadingText.length < FAKE_PREFIX.length) {
          // The fake client streams 4-char chunks, so the marker spans events.
          leadingText += typeof event.text === "string" ? event.text : typeof event.delta === "string" ? event.delta : "";
          if (leadingText.length >= FAKE_PREFIX.length) sample.fake = leadingText.startsWith(FAKE_PREFIX);
        }
        if (event.type === "done" || event.type === "failed") {
          sample.terminal = `${event.type}:${event.stopReason ?? "?"}`;
        } else if (event.type === "error") {
          sample.error = typeof event.message === "string" ? event.message.slice(0, 200) : "error event";
        }
      }
    }
    if (!sample.terminal) sample.terminal = "failed:no_terminal_event";
  } catch (err) {
    sample.error = errorName(err);
    if (sample.status !== null && sample.firstEventMs !== undefined) sample.terminal = "failed:stream_aborted";
  }
  sample.totalMs = performance.now() - t0;
  return sample;
}

// --- closed-loop virtual users --------------------------------------------

async function runClosedLoop({ concurrency, durationMs, maxRequests, request }) {
  const samples = [];
  const started = performance.now();
  const deadline = durationMs ? started + durationMs : Infinity;
  let issued = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, vu) => {
      while (performance.now() < deadline && (maxRequests === undefined || issued < maxRequests)) {
        const seq = issued++;
        samples.push(await request({ vu, seq }));
      }
    }),
  );
  return { samples, durationMs: performance.now() - started };
}

// --- optional pg_stat_activity sampler (needs psql on PATH) ------------------

async function psqlScalar(dbUrl, sql) {
  const { stdout } = await execFileAsync("psql", [dbUrl, "-X", "-tAc", sql], { timeout: 5000 });
  return stdout.trim();
}

async function createDbSampler(dbUrl) {
  if (!dbUrl) return null;
  let maxConnections = null;
  try {
    maxConnections = Number(await psqlScalar(dbUrl, "show max_connections"));
  } catch (err) {
    console.warn(`pg_stat_activity sampling disabled: ${errorName(err)} (is psql on PATH and --db-url reachable?)`);
    return null;
  }
  // Excludes the sampler's own backend so the peak is the app's connections.
  const countSql = "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()";
  return {
    maxConnections,
    start() {
      const counts = [];
      let inFlight = false;
      const timer = setInterval(async () => {
        if (inFlight) return;
        inFlight = true;
        try {
          counts.push(Number(await psqlScalar(dbUrl, countSql)));
        } catch {
          // a missed sample is not a result
        } finally {
          inFlight = false;
        }
      }, 250);
      return async () => {
        clearInterval(timer);
        try {
          counts.push(Number(await psqlScalar(dbUrl, countSql)));
        } catch {
          // ignore
        }
        return { peak: counts.length ? Math.max(...counts) : 0, samples: counts.length, maxConnections };
      };
    },
  };
}

// --- scenarios --------------------------------------------------------------

function chatMessage(seq) {
  // Deliberately free of the durable-intent vocabulary in
  // apps/web/lib/chat-routing.ts so the turn stays on the inline lane.
  return `Say hello and share one fun fact about the number ${seq}.`;
}

async function scenarioHealth(ctx) {
  const request = () => healthRequest(ctx);
  for (let i = 0; i < ctx.args.warmup; i += 1) await request();
  const stop = ctx.sampler?.start();
  const run = await runClosedLoop({
    concurrency: ctx.args["health-concurrency"],
    durationMs: ctx.args.duration * 1000,
    request,
  });
  return scenarioReport({ name: "health", concurrency: ctx.args["health-concurrency"], ...run, db: stop ? await stop() : undefined });
}

async function scenarioChat(ctx) {
  const { identities } = ctx;
  const threads = new Map(); // identity label → { id, turns }
  let cursor = 0;
  const request = async ({ seq }) => {
    const identity = identities[cursor++ % identities.length];
    const thread = threads.get(identity.label);
    const body = { message: chatMessage(seq), timeZone: "UTC", ...(thread ? { threadId: thread.id } : {}) };
    const sample = await chatTurn({ ...ctx, identity, body });
    if (sample.threadId) {
      const turns = (thread?.turns ?? 0) + 1;
      if (turns >= ctx.args["turns-per-thread"]) threads.delete(identity.label);
      else threads.set(identity.label, { id: sample.threadId, turns });
    }
    return sample;
  };
  for (let i = 0; i < ctx.args.warmup; i += 1) await request({ seq: -1 - i });
  const stop = ctx.sampler?.start();
  const run = await runClosedLoop({
    concurrency: ctx.args["chat-concurrency"],
    durationMs: ctx.args.duration * 1000,
    request,
  });
  return scenarioReport({ name: "chat", concurrency: ctx.args["chat-concurrency"], ...run, db: stop ? await stop() : undefined });
}

async function scenarioBurst(ctx) {
  const identity = ctx.identities[0];
  const oversized = "x".repeat(CHAT_MAX_MESSAGE_CHARS + 1);
  const request = ({ seq }) =>
    chatTurn({
      ...ctx,
      identity,
      body: { message: seq % 10 === 9 ? oversized : chatMessage(seq), timeZone: "UTC" },
    });
  // No warm-up: every accepted request counts against the window under test.
  const stop = ctx.sampler?.start();
  const run = await runClosedLoop({
    concurrency: ctx.args["burst-concurrency"],
    maxRequests: ctx.args["burst-requests"],
    request,
  });
  return scenarioReport({ name: "burst", concurrency: ctx.args["burst-concurrency"], ...run, db: stop ? await stop() : undefined });
}

const SCENARIOS = { health: scenarioHealth, chat: scenarioChat, burst: scenarioBurst };

// --- main -------------------------------------------------------------------

async function preflight(ctx) {
  const health = await healthRequest(ctx);
  if (health.status !== 200) {
    throw new Error(`preflight: GET /api/health returned ${health.status ?? health.error} — is the server up at ${ctx.baseUrl}?`);
  }
  const identity = ctx.identities[0];
  const res = await fetch(new URL("/api/me", ctx.baseUrl), {
    headers: { cookie: identity.cookie },
    redirect: "manual",
    signal: AbortSignal.timeout(ctx.timeoutMs),
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(
      `preflight: GET /api/me as ${identity.label} returned ${res.status} ${text.slice(0, 200)} — seed users with \`pnpm --filter @ai-workspace/web seed:load-users\` against the server's DATABASE_URL, and mint with the server's NEXTAUTH_SECRET.`,
    );
  }
  if (identity.id && !text.includes(identity.id)) {
    throw new Error(`preflight: /api/me resolved to a different user than ${identity.label}; a stale users row or ping_subject mismatch.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = new URL(args["base-url"]);
  const scenarios = args.scenarios.split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of scenarios) if (!(s in SCENARIOS)) throw new Error(`unknown scenario ${s}`);
  const { mode, identities } = buildIdentities(args, baseUrl);
  const sampler = await createDbSampler(args["db-url"]);
  const ctx = { args, baseUrl, identities, sampler, timeoutMs: args["turn-timeout"] };

  const machine = {
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    totalMemGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
  };
  console.log(`Pilot load test → ${baseUrl.origin}`);
  console.log(`Machine: ${machine.cpu} · ${machine.cores} cores · ${machine.totalMemGiB} GiB · ${machine.platform} · node ${machine.node}`);
  console.log(`Identities: ${mode}; pg_stat_activity sampling: ${sampler ? `on (max_connections ${sampler.maxConnections})` : "off"}`);

  await preflight(ctx);

  const reports = [];
  for (const name of scenarios) {
    console.log(`\n▶ ${name} …`);
    const report = await SCENARIOS[name](ctx);
    reports.push(report);
    console.log(
      `  ${report.requests} requests in ${(report.durationMs / 1000).toFixed(1)} s (${report.rps.toFixed(1)} req/s) · ` +
        `statuses ${JSON.stringify(report.statuses)}` +
        (name !== "health" ? ` · fake-model turns ${report.fakeTurns}/${report.ok}` : "") +
        (report.db ? ` · pg connections peak ${report.db.peak}/${report.db.maxConnections}` : ""),
    );
  }

  const thresholds = evaluateThresholds(reports);
  console.log(`\n${formatTable(LATENCY_HEADERS, latencyRows(reports))}\n`);
  console.log(formatTable(["threshold (docs/ENTERPRISE_READINESS.md)", "result", "measured"], thresholds.map((t) => [t.row, t.status.toUpperCase(), t.measured])));

  const outPath = args.out || path.join("tmp", "load", `pilot-load-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl: baseUrl.origin, identities: mode, machine, args: { ...args, cookie: args.cookie ? "<redacted>" : "", secret: args.secret ? "<redacted>" : "", "db-url": args["db-url"] ? "<redacted>" : "" }, scenarios: reports, thresholds }, null, 2),
  );
  console.log(`\nJSON report: ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
