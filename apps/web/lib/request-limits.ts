import type { Database } from "@ai-workspace/db";
import { sql } from "drizzle-orm";

export interface RequestLimitConfig {
  maxRequestBytes: number;
  maxMessageChars: number;
  windowMs: number;
  maxRequests: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitStore {
  consume(
    key: string,
    config: RequestLimitConfig,
    now: Date,
  ): Promise<{ count: number; resetAt: Date }>;
}

const localBuckets = new Map<string, Bucket>();

export function requestLimitConfig(): RequestLimitConfig {
  return {
    maxRequestBytes: numberFromEnv("CHAT_MAX_REQUEST_BYTES", 256 * 1024),
    maxMessageChars: numberFromEnv("CHAT_MAX_MESSAGE_CHARS", 24_000),
    windowMs: numberFromEnv("CHAT_RATE_LIMIT_WINDOW_MS", 60_000),
    maxRequests: numberFromEnv("CHAT_RATE_LIMIT_REQUESTS", 30),
  };
}

export function contentLengthTooLarge(
  headers: Headers,
  maxRequestBytes: number,
): boolean {
  const raw = headers.get("content-length");
  if (!raw) return false;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > maxRequestBytes;
}

export async function checkRateLimit(
  db: Database,
  key: string,
  config = requestLimitConfig(),
  now = new Date(),
): Promise<RateLimitResult> {
  return checkRateLimitWithStore(postgresRateLimitStore(db), key, config, now);
}

export async function checkRateLimitWithStore(
  store: RateLimitStore,
  key: string,
  config = requestLimitConfig(),
  now = new Date(),
): Promise<RateLimitResult> {
  const bucket = await store.consume(key, config, now);
  const remaining = Math.max(0, config.maxRequests - bucket.count);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((bucket.resetAt.getTime() - now.getTime()) / 1000),
  );

  return {
    allowed: bucket.count <= config.maxRequests,
    limit: config.maxRequests,
    remaining,
    resetAt: bucket.resetAt,
    retryAfterSeconds,
  };
}

export function resetRequestLimitBuckets(): void {
  localBuckets.clear();
}

export function inMemoryRateLimitStore(
  buckets: Map<string, Bucket> = localBuckets,
): RateLimitStore {
  return {
    async consume(key, config, now) {
      const nowMs = now.getTime();
      const existing = buckets.get(key);
      const bucket =
        existing && existing.resetAt > nowMs
          ? existing
          : { count: 0, resetAt: nowMs + config.windowMs };

      bucket.count += 1;
      buckets.set(key, bucket);

      return { count: bucket.count, resetAt: new Date(bucket.resetAt) };
    },
  };
}

function postgresRateLimitStore(db: Database): RateLimitStore {
  return {
    async consume(key, config, now) {
      const resetAt = new Date(now.getTime() + config.windowMs);
      const nowSql = now.toISOString();
      const resetAtSql = resetAt.toISOString();
      const rows = await db.execute<{ count: number; reset_at: Date | string }>(
        sql`
          insert into "rate_limit_buckets"
            ("bucket_key", "count", "reset_at", "updated_at")
          values
            (${key}, 1, ${resetAtSql}, ${nowSql})
          on conflict ("bucket_key") do update set
            "count" = case
              when "rate_limit_buckets"."reset_at" <= ${nowSql}
                then 1
              else "rate_limit_buckets"."count" + 1
            end,
            "reset_at" = case
              when "rate_limit_buckets"."reset_at" <= ${nowSql}
                then ${resetAtSql}
              else "rate_limit_buckets"."reset_at"
            end,
            "updated_at" = ${nowSql}
          returning "count", "reset_at"
        `,
      );
      const row = rows[0];
      if (!row) {
        throw new Error("Rate-limit bucket update returned no row.");
      }
      return {
        count: Number(row.count),
        resetAt:
          row.reset_at instanceof Date ? row.reset_at : new Date(row.reset_at),
      };
    },
  };
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
