import { afterEach, describe, expect, it } from "vitest";
import {
  checkRateLimitWithStore,
  contentLengthTooLarge,
  inMemoryRateLimitStore,
  resetRequestLimitBuckets,
} from "@/lib/request-limits";

afterEach(() => {
  resetRequestLimitBuckets();
});

describe("request limits", () => {
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
