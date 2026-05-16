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

const buckets = new Map<string, Bucket>();

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

export function checkRateLimit(
  key: string,
  config = requestLimitConfig(),
  now = Date.now(),
): RateLimitResult {
  const existing = buckets.get(key);
  const bucket =
    existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + config.windowMs };

  bucket.count += 1;
  buckets.set(key, bucket);

  const remaining = Math.max(0, config.maxRequests - bucket.count);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((bucket.resetAt - now) / 1000),
  );

  return {
    allowed: bucket.count <= config.maxRequests,
    limit: config.maxRequests,
    remaining,
    resetAt: new Date(bucket.resetAt),
    retryAfterSeconds,
  };
}

export function resetRequestLimitBuckets(): void {
  buckets.clear();
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
