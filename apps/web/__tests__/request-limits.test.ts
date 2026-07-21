import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@ai-workspace/db";
import { MAX_ATTACHMENT_BYTES } from "@/lib/attachments";
import {
  checkRateLimit,
  checkRateLimitWithStore,
  contentLengthTooLarge,
  inMemoryRateLimitStore,
  requestLimitConfig,
  resetRequestLimitBuckets,
} from "@/lib/request-limits";

afterEach(() => {
  resetRequestLimitBuckets();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("request limits", () => {
  it("allows base64 and JSON overhead for one maximum-size attachment", () => {
    vi.stubEnv("CHAT_MAX_REQUEST_BYTES", "");
    const maxRequestBytes = requestLimitConfig().maxRequestBytes;
    const base64Bytes = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3);
    expect(maxRequestBytes).toBe(16 * 1024 * 1024);
    expect(maxRequestBytes - base64Bytes).toBeGreaterThan(2 * 1024 * 1024);
  });

  it("detects oversized content-length headers", () => {
    expect(contentLengthTooLarge(new Headers({ "content-length": "11" }), 10))
      .toBe(true);
    expect(contentLengthTooLarge(new Headers({ "content-length": "10" }), 10))
      .toBe(false);
    expect(contentLengthTooLarge(new Headers(), 10)).toBe(false);
  });

  it("enforces a fixed-window per-key request cap", async () => {
    const config = {
      maxRequestBytes: 1000,
      maxMessageChars: 100,
      windowMs: 60_000,
      maxRequests: 2,
    };
    const store = inMemoryRateLimitStore();

    await expect(
      checkRateLimitWithStore(store, "u1", config, new Date(1000)),
    ).resolves.toMatchObject({
      allowed: true,
      remaining: 1,
    });
    await expect(
      checkRateLimitWithStore(store, "u1", config, new Date(1001)),
    ).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
    await expect(
      checkRateLimitWithStore(store, "u1", config, new Date(1002)),
    ).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 60,
    });
    await expect(
      checkRateLimitWithStore(store, "u1", config, new Date(61_001)),
    ).resolves.toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });

  it("shares the same bucket across simulated web tasks", async () => {
    const config = {
      maxRequestBytes: 1000,
      maxMessageChars: 100,
      windowMs: 60_000,
      maxRequests: 2,
    };
    const sharedBuckets = new Map();
    const webTaskA = inMemoryRateLimitStore(sharedBuckets);
    const webTaskB = inMemoryRateLimitStore(sharedBuckets);

    await expect(
      checkRateLimitWithStore(webTaskA, "chat:u1", config, new Date(1000)),
    ).resolves.toMatchObject({ allowed: true, remaining: 1 });
    await expect(
      checkRateLimitWithStore(webTaskB, "chat:u1", config, new Date(1001)),
    ).resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(
      checkRateLimitWithStore(webTaskA, "chat:u1", config, new Date(1002)),
    ).resolves.toMatchObject({ allowed: false, remaining: 0 });
  });
});

describe("expired-bucket sweep (Postgres store)", () => {
  const config = {
    maxRequestBytes: 1000,
    maxMessageChars: 100,
    windowMs: 60_000,
    maxRequests: 2,
  };

  /** Flatten a drizzle sql`` object into readable text (chunks + params). */
  function sqlText(query: unknown): string {
    const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
    return chunks
      .map((chunk) => {
        if (typeof chunk === "string") return chunk; // raw bound param
        const value = (chunk as { value?: unknown }).value;
        if (Array.isArray(value)) return value.join("");
        return typeof value === "string" ? value : "";
      })
      .join("");
  }

  /**
   * Fake Database capturing every execute. The upsert (first statement of a
   * consume) needs a row back; the sweep DELETE ignores its result, so a
   * constant return serves both.
   */
  function fakeDb() {
    const executes: unknown[] = [];
    const db = {
      execute: async (query: unknown) => {
        executes.push(query);
        return [{ count: 1, reset_at: new Date(Date.now() + 60_000) }];
      },
    } as unknown as Database;
    return { db, executes };
  }

  it("sweeps on the first consume of a fresh process, then every 50th", async () => {
    const { db, executes } = fakeDb();

    // Consume #1: upsert + sweep.
    await checkRateLimit(db, "chat:u1", config);
    expect(executes).toHaveLength(2);

    // Consumes #2..#50: upsert only.
    for (let i = 2; i <= 50; i += 1) {
      await checkRateLimit(db, `chat:u${i}`, config);
    }
    expect(executes).toHaveLength(51);

    // Consume #51: upsert + sweep again.
    await checkRateLimit(db, "chat:u51", config);
    expect(executes).toHaveLength(53);

    // The sweep statement deletes strictly pre-grace rows.
    const sweep = sqlText(executes[1]);
    expect(sweep).toContain("delete from");
    expect(sweep).toContain("rate_limit_buckets");
    expect(sweep).toContain("reset_at");
  });

  it("keeps the grace window: the sweep cutoff is one hour behind now", async () => {
    const { db, executes } = fakeDb();
    const now = new Date("2026-07-20T12:00:00.000Z");

    await checkRateLimit(db, "chat:u1", config, now);

    // The DELETE is parameterized on the cutoff timestamp.
    expect(sqlText(executes[1])).toContain("2026-07-20T11:00:00.000Z");
  });

  it("never fails the rate-limit decision when the sweep errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const db = {
      execute: async () => {
        calls += 1;
        if (calls === 2) throw new Error("sweep exploded");
        return [{ count: 1, reset_at: new Date(Date.now() + 60_000) }];
      },
    } as unknown as Database;

    await expect(checkRateLimit(db, "chat:u1", config)).resolves.toMatchObject({
      allowed: true,
    });
    expect(warn).toHaveBeenCalledWith(
      "rate_limit_buckets sweep failed",
      expect.any(Error),
    );
  });
});
