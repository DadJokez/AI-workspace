import { decode } from "next-auth/jwt";
import { describe, expect, it } from "vitest";
import {
  deriveEncryptionKey,
  mintSessionToken,
  sessionCookie,
} from "../../../scripts/load/session.mjs";
import {
  evaluateThresholds,
  formatTable,
  percentile,
  scenarioReport,
  statusHistogram,
  summarizeLatencies,
} from "../../../scripts/load/stats.mjs";
import { loadUser } from "../../../scripts/load/users.mjs";

describe("load-test session minting", () => {
  it("mints a JWE that next-auth/jwt decodes with the same secret", async () => {
    const secret = "unit-test-secret-with-enough-length-for-hkdf";
    const user = loadUser(7);
    const token = mintSessionToken(deriveEncryptionKey(secret), user, 60);
    const payload = await decode({ token, secret });
    expect(payload).toMatchObject({
      sub: "load-user-7",
      ghSub: "load-user-7",
      userId: user.id,
      role: "user",
      email: user.email,
      name: user.displayName,
    });
    expect(Number(payload!.exp) - Number(payload!.iat)).toBe(60);
    await expect(decode({ token, secret: "a-different-secret-of-similar-length" })).rejects.toThrow();
  });

  it("uses the __Secure- cookie prefix only for https origins", () => {
    expect(sessionCookie(new URL("http://127.0.0.1:3000"), "t")).toBe("next-auth.session-token=t");
    expect(sessionCookie(new URL("https://example.test"), "t")).toBe("__Secure-next-auth.session-token=t");
  });
});

const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);

describe("load-test percentile helpers", () => {
  it("uses nearest-rank percentiles on an unsorted input", () => {
    const shuffled = [...oneToHundred].reverse();
    expect(percentile(shuffled, 50)).toBe(50);
    expect(percentile(shuffled, 95)).toBe(95);
    expect(percentile(shuffled, 99)).toBe(99);
    expect(percentile(shuffled, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
  });

  it("summarizes min/mean/max alongside percentiles", () => {
    expect(summarizeLatencies([3, 1, 2])).toEqual({
      count: 3,
      min: 1,
      mean: 2,
      p50: 2,
      p95: 3,
      p99: 3,
      max: 3,
    });
    expect(summarizeLatencies([]).count).toBe(0);
  });

  it("buckets transport failures separately from HTTP statuses", () => {
    expect(
      statusHistogram([{ status: 200 }, { status: 429 }, { status: null }, { status: 200 }]),
    ).toEqual({ "200": 2, "429": 1, error: 1 });
  });
});

describe("scenarioReport", () => {
  it("computes accepted-turn latencies over 2xx samples only", () => {
    const report = scenarioReport({
      name: "chat",
      concurrency: 2,
      durationMs: 2000,
      samples: [
        { status: 200, totalMs: 900, ttfbMs: 40, firstEventMs: 60, terminal: "done:completed", fake: true },
        { status: 200, totalMs: 1100, ttfbMs: 50, firstEventMs: 80, terminal: "failed:runtime_error" },
        { status: 429, totalMs: 5, retryAfter: "42" },
        { status: null, totalMs: 30000, error: "TimeoutError" },
      ],
    });
    expect(report.requests).toBe(4);
    expect(report.rps).toBe(2);
    expect(report.ok).toBe(2);
    expect(report.rateLimited).toBe(1);
    expect(report.rateLimitedWithRetryAfter).toBe(1);
    expect(report.transportErrors).toBe(1);
    expect(report.failedTurns).toBe(1);
    expect(report.fakeTurns).toBe(1);
    expect(report.latency.total.count).toBe(4);
    expect(report.latency.firstEvent).toMatchObject({ count: 2, p95: 80 });
    expect(report.latency.rateLimited).toMatchObject({ count: 1, p95: 5 });
    expect(report.errorSamples).toHaveLength(2);
  });
});

describe("evaluateThresholds", () => {
  const health = (p95: number, serverErrors = 0) => ({
    name: "health",
    concurrency: 50,
    requests: 100,
    serverErrors,
    transportErrors: 0,
    latency: { total: { p95 } },
  });

  it("marks the doc rows pass/fail from measured numbers", () => {
    const burstSamples = [
      ...Array.from({ length: 30 }, () => ({ status: 200, totalMs: 800, ttfbMs: 20, firstEventMs: 30, terminal: "done:completed" })),
      ...Array.from({ length: 70 }, () => ({ status: 429, totalMs: 6, retryAfter: "55" })),
    ];
    const burst = scenarioReport({
      name: "burst",
      concurrency: 50,
      durationMs: 3000,
      samples: burstSamples,
      db: { peak: 12, maxConnections: 100, samples: 6 },
    });
    const chat = scenarioReport({
      name: "chat",
      concurrency: 25,
      durationMs: 60000,
      samples: Array.from({ length: 50 }, () => ({ status: 200, totalMs: 700, ttfbMs: 30, firstEventMs: 45, terminal: "done:completed" })),
    });
    const rows = evaluateThresholds([health(120), chat, burst]);
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ["health_p95", "pass"],
      ["chat_accept_p95", "pass"],
      ["burst_no_exhaustion", "pass"],
      ["burst_429_retry_after", "pass"],
    ]);
    expect(rows[2]!.measured).toContain("peak 12 of max_connections 100");
  });

  it("fails on breached latency, missing Retry-After, or exhausted connections", () => {
    const burst = scenarioReport({
      name: "burst",
      concurrency: 50,
      durationMs: 1000,
      samples: [
        { status: 429, totalMs: 4, retryAfter: "10" },
        { status: 429, totalMs: 4 },
        { status: 503, totalMs: 900 },
      ],
      db: { peak: 100, maxConnections: 100, samples: 3 },
    });
    const rows = evaluateThresholds([health(251), burst]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.health_p95!.status).toBe("fail");
    expect(byId.chat_accept_p95!.status).toBe("not-measured");
    expect(byId.burst_no_exhaustion!.status).toBe("fail");
    expect(byId.burst_429_retry_after!.status).toBe("fail");
    expect(byId.burst_429_retry_after!.measured).toContain("2 × 429, 1 with Retry-After");
  });

  it("passes the exhaustion row on a clean burst but says connections were not sampled", () => {
    const burst = scenarioReport({
      name: "burst",
      concurrency: 10,
      durationMs: 1000,
      samples: [{ status: 429, totalMs: 4, retryAfter: "10" }],
    });
    const row = evaluateThresholds([burst]).find((r) => r.id === "burst_no_exhaustion")!;
    expect(row.status).toBe("pass");
    expect(row.measured).toContain("NOT sampled");
  });
});

describe("formatTable", () => {
  it("pads columns into an aligned markdown table", () => {
    const table = formatTable(["a", "bbb"], [["1", "2"], ["333", "4"]]);
    expect(table.split("\n")).toEqual([
      "| a   | bbb |",
      "| --- | --- |",
      "| 1   | 2   |",
      "| 333 | 4   |",
    ]);
  });
});

describe("loadUser", () => {
  it("derives deterministic v4-shaped ids in a reserved block", () => {
    expect(loadUser(0).id).toBe("00000000-0000-4000-8000-00000ad00000");
    expect(loadUser(999)).toMatchObject({
      id: "00000000-0000-4000-8000-00000ad003e7",
      pingSubject: "load-user-999",
      email: "load-user-999@load.invalid",
      role: "user",
    });
    expect(() => loadUser(65536)).toThrow(RangeError);
  });
});
