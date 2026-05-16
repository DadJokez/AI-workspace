import { afterEach, describe, expect, it } from "vitest";
import {
  checkRateLimit,
  contentLengthTooLarge,
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

  it("enforces a fixed-window per-key request cap", () => {
    const config = {
      maxRequestBytes: 1000,
      maxMessageChars: 100,
      windowMs: 60_000,
      maxRequests: 2,
    };

    expect(checkRateLimit("u1", config, 1000)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(checkRateLimit("u1", config, 1001)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(checkRateLimit("u1", config, 1002)).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 60,
    });
    expect(checkRateLimit("u1", config, 61_001)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });
});
