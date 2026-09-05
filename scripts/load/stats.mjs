/**
 * Pure reporting helpers for `scripts/load/pilot-load.mjs` (#696).
 *
 * No I/O and no Node-only imports so `apps/web/__tests__/load-stats.test.ts`
 * can cover them with vitest. Latencies are milliseconds.
 *
 * A sample is `{ status, totalMs, ttfbMs?, firstEventMs?, terminal?, error?,
 * retryAfter?, fake?, dbLatencyMs? }` — `status` is the HTTP status, or
 * `null` when the request never produced one (timeout, connection reset).
 */

/** Nearest-rank percentile. `p` is 0–100. Returns null for an empty input. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function summarizeLatencies(values) {
  if (values.length === 0) {
    return { count: 0, min: null, mean: null, p50: null, p95: null, p99: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

/** `{ "200": n, "429": m, "error": k }` — transport failures count as "error". */
export function statusHistogram(samples) {
  const out = {};
  for (const s of samples) {
    const key = s.status == null ? "error" : String(s.status);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function inRange(status, lo, hi) {
  return typeof status === "number" && status >= lo && status <= hi;
}

/**
 * Per-scenario report. `total` covers every sample (a 429 is a real response
 * with a real latency); `ttfb`/`firstEvent`/`serverDb` cover successful
 * responses only, so a burst of 429s cannot make "time to accepted turn"
 * look faster than it is.
 *
 * @param {{
 *   name: string,
 *   concurrency: number,
 *   samples: Array<Record<string, unknown>>,
 *   durationMs: number,
 *   db?: { peak: number, samples: number, maxConnections: number | null } | null,
 * }} input
 */
export function scenarioReport({ name, concurrency, samples, durationMs, db = null }) {
  const ok = samples.filter((s) => inRange(s.status, 200, 299));
  const seconds = durationMs / 1000;
  const fakeTurns = ok.filter((s) => s.fake === true).length;
  const failedTurns = ok.filter(
    (s) => typeof s.terminal === "string" && !s.terminal.startsWith("done"),
  ).length;
  const pick = (rows, key) =>
    rows.map((s) => s[key]).filter((v) => typeof v === "number");
  return {
    name,
    concurrency,
    requests: samples.length,
    durationMs,
    rps: seconds > 0 ? samples.length / seconds : 0,
    statuses: statusHistogram(samples),
    ok: ok.length,
    clientErrors: samples.filter((s) => inRange(s.status, 400, 499)).length,
    serverErrors: samples.filter((s) => inRange(s.status, 500, 599)).length,
    transportErrors: samples.filter((s) => s.status == null).length,
    failedTurns,
    fakeTurns,
    rateLimited: samples.filter((s) => s.status === 429).length,
    rateLimitedWithRetryAfter: samples.filter(
      (s) => s.status === 429 && typeof s.retryAfter === "string" && s.retryAfter !== "",
    ).length,
    latency: {
      total: summarizeLatencies(pick(samples, "totalMs")),
      ttfb: summarizeLatencies(pick(ok, "ttfbMs")),
      firstEvent: summarizeLatencies(pick(ok, "firstEventMs")),
      serverDb: summarizeLatencies(pick(ok, "dbLatencyMs")),
      rateLimited: summarizeLatencies(
        pick(samples.filter((s) => s.status === 429), "totalMs"),
      ),
    },
    errorSamples: samples
      .filter((s) => s.status == null || inRange(s.status, 500, 599) || s.terminal?.startsWith("failed"))
      .slice(0, 5)
      .map((s) => ({ status: s.status, error: s.error ?? null, terminal: s.terminal ?? null })),
    db: db ?? null,
  };
}

/**
 * The docs/ENTERPRISE_READINESS.md "Load-Test Model" rows this harness can
 * measure. Rows it cannot (audit rows without secrets, cost alarms) are not
 * listed rather than reported as passing.
 */
export const THRESHOLD_ROWS = [
  {
    id: "health_p95",
    scenario: "health",
    row: "p95 `/api/health` under 250ms when DB is healthy",
  },
  {
    id: "chat_accept_p95",
    scenario: "chat",
    row: "p95 non-tool chat request accepted under 500ms before first model byte",
  },
  {
    id: "burst_no_exhaustion",
    scenario: "burst",
    row: "no DB connection exhaustion during burst tests",
  },
  {
    id: "burst_429_retry_after",
    scenario: "burst",
    row: "rate-limited requests return 429 with `Retry-After`",
  },
];

function fmtMs(v) {
  return v == null ? "n/a" : `${v.toFixed(1)} ms`;
}

/** @returns {{id,row,scenario,status:"pass"|"fail"|"not-measured",measured:string}[]} */
export function evaluateThresholds(reports) {
  const byName = new Map(reports.map((r) => [r.name, r]));
  return THRESHOLD_ROWS.map((t) => {
    const r = byName.get(t.scenario);
    if (!r || r.requests === 0) {
      return { ...t, status: "not-measured", measured: "scenario not run" };
    }
    switch (t.id) {
      case "health_p95": {
        const p95 = r.latency.total.p95;
        const healthy = r.serverErrors === 0 && r.transportErrors === 0;
        return {
          ...t,
          status: p95 != null && p95 < 250 && healthy ? "pass" : "fail",
          measured: `p95 ${fmtMs(p95)} over ${r.requests} requests at ${r.concurrency} concurrent; 5xx=${r.serverErrors}, transport errors=${r.transportErrors}`,
        };
      }
      case "chat_accept_p95": {
        const p95 = r.latency.firstEvent.p95;
        return {
          ...t,
          status: p95 != null && p95 < 500 && r.serverErrors === 0 && r.transportErrors === 0 ? "pass" : "fail",
          measured: `p95 time-to-\`meta\` ${fmtMs(p95)} over ${r.ok} accepted turns at ${r.concurrency} concurrent (ttfb p95 ${fmtMs(r.latency.ttfb.p95)}, full turn p95 ${fmtMs(r.latency.total.p95)}); 429=${r.rateLimited}, 5xx=${r.serverErrors}, failed streams=${r.failedTurns}`,
        };
      }
      case "burst_no_exhaustion": {
        const noErrors = r.serverErrors === 0 && r.transportErrors === 0;
        if (!r.db) {
          return {
            ...t,
            status: noErrors ? "pass" : "fail",
            measured: `5xx=${r.serverErrors}, transport errors=${r.transportErrors}; pg_stat_activity NOT sampled (pass --db-url to sample)`,
          };
        }
        const headroom = r.db.maxConnections == null || r.db.peak < r.db.maxConnections;
        return {
          ...t,
          status: noErrors && headroom ? "pass" : "fail",
          measured: `pg_stat_activity peak ${r.db.peak}${r.db.maxConnections != null ? ` of max_connections ${r.db.maxConnections}` : ""} across ${r.db.samples} samples; 5xx=${r.serverErrors}, transport errors=${r.transportErrors}`,
        };
      }
      case "burst_429_retry_after": {
        const all = r.rateLimited > 0 && r.rateLimitedWithRetryAfter === r.rateLimited;
        return {
          ...t,
          status: all ? "pass" : "fail",
          measured: `${r.rateLimited} × 429, ${r.rateLimitedWithRetryAfter} with Retry-After; 429 latency p95 ${fmtMs(r.latency.rateLimited.p95)}`,
        };
      }
      default:
        return { ...t, status: "not-measured", measured: "no evaluator" };
    }
  });
}

/** Markdown table; pads columns so it also reads cleanly on a terminal. */
export function formatTable(headers, rows) {
  const cells = [headers, ...rows].map((r) => r.map((c) => String(c)));
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  const line = (r) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  const sep = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;
  return [line(cells[0]), sep, ...cells.slice(1).map(line)].join("\n");
}

export function latencyRows(reports) {
  const rows = [];
  for (const r of reports) {
    const codes = Object.entries(r.statuses)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");
    const push = (metric, s) => {
      if (s.count === 0) return;
      rows.push([
        r.name,
        metric,
        r.concurrency,
        s.count,
        r.rps.toFixed(1),
        fmtMs(s.p50),
        fmtMs(s.p95),
        fmtMs(s.p99),
        fmtMs(s.max),
        `${(((r.serverErrors + r.transportErrors + r.failedTurns) / Math.max(1, r.requests)) * 100).toFixed(2)}%`,
        codes,
      ]);
    };
    push("response (all)", r.latency.total);
    push("ttfb (2xx)", r.latency.ttfb);
    push("first SSE event (2xx)", r.latency.firstEvent);
    push("server-reported db ping", r.latency.serverDb);
    push("429 response", r.latency.rateLimited);
  }
  return rows;
}

export const LATENCY_HEADERS = [
  "scenario",
  "metric",
  "conc",
  "n",
  "req/s",
  "p50",
  "p95",
  "p99",
  "max",
  "err%",
  "status codes",
];
