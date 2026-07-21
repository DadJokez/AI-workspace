import { afterEach, describe, expect, it, vi } from "vitest";
import type { RateLimitResult, RequestLimitConfig } from "@/lib/request-limits";

/**
 * The [...nextauth] POST wrapper: magic-link requests are rate limited BEFORE
 * next-auth sees them, across two buckets:
 *
 *   - `magic-link-email:<email>` — the enforcing cap. Client-supplied
 *     forwarding headers never touch this key, so spoofed/rotating
 *     X-Forwarded-For values cannot bypass it.
 *   - `magic-link:<email>:<ip>` — best-effort secondary keyed on the
 *     RIGHTMOST x-forwarded-for hop (the one our ALB appends).
 *
 * Every other auth POST passes through untouched.
 */

afterEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

const nextAuthHandler = vi.fn<() => Promise<Response>>();
const checkRateLimit =
  vi.fn<
    (
      db: unknown,
      key: string,
      config: RequestLimitConfig,
    ) => Promise<RateLimitResult>
  >();

async function loadRoute() {
  // Re-armed here because afterEach resets implementations.
  nextAuthHandler.mockImplementation(
    async () => new Response("nextauth-handled", { status: 200 }),
  );
  vi.doMock("next-auth", () => ({
    default: () => nextAuthHandler,
  }));
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    return { ...actual, getDb: () => ({}) as never };
  });
  vi.doMock("@/lib/request-limits", async () => {
    const actual = await vi.importActual<
      typeof import("@/lib/request-limits")
    >("@/lib/request-limits");
    return { ...actual, checkRateLimit };
  });
  return import("@/app/api/auth/[...nextauth]/route");
}

/** Stateful fake: real fixed-window counting per bucket key. */
function armCountingRateLimiter() {
  const counts = new Map<string, number>();
  checkRateLimit.mockImplementation(async (_db, key, config) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return {
      allowed: count <= config.maxRequests,
      limit: config.maxRequests,
      remaining: Math.max(0, config.maxRequests - count),
      resetAt: new Date(Date.now() + config.windowMs),
      retryAfterSeconds: Math.ceil(config.windowMs / 1000),
    };
  });
  return counts;
}

function allowedRate(): RateLimitResult {
  return {
    allowed: true,
    limit: 5,
    remaining: 3,
    resetAt: new Date(Date.now() + 60_000),
    retryAfterSeconds: 60,
  };
}

function blockedRate(): RateLimitResult {
  return {
    allowed: false,
    limit: 5,
    remaining: 0,
    resetAt: new Date("2026-07-20T12:15:00Z"),
    retryAfterSeconds: 540,
  };
}

function signinEmailRequest(
  email: string,
  headers: Record<string, string> = {},
): Request {
  const body = new URLSearchParams({
    email,
    csrfToken: "csrf",
    callbackUrl: "http://localhost:3000/chat",
    json: "true",
  });
  return new Request("http://localhost:3000/api/auth/signin/email", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: body.toString(),
  });
}

const ctx = { params: Promise.resolve({ nextauth: ["signin", "email"] }) };

describe("[...nextauth] POST wrapper — magic-link rate limit", () => {
  it("consumes the per-email cap and the rightmost-hop email:IP bucket for an honest request", async () => {
    checkRateLimit
      .mockResolvedValueOnce(allowedRate())
      .mockResolvedValueOnce(allowedRate());
    const { POST } = await loadRoute();

    const res = await POST(
      signinEmailRequest(" Tester@Example.com ", {
        // Leftmost entry is client-influencable; the ALB appends 10.0.0.2.
        "x-forwarded-for": "203.0.113.9, 10.0.0.2",
      }),
      ctx,
    );

    expect(checkRateLimit).toHaveBeenCalledTimes(2);
    expect(checkRateLimit.mock.calls.map((call) => call[1])).toEqual([
      "magic-link-email:tester@example.com",
      "magic-link:tester@example.com:10.0.0.2",
    ]);
    expect(checkRateLimit.mock.calls[0]![2]).toMatchObject({
      windowMs: 15 * 60 * 1000,
      maxRequests: 5,
    });
    // Allowed: delegated to next-auth with the body still readable.
    expect(nextAuthHandler).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("nextauth-handled");
  });

  it("spoofed leftmost x-forwarded-for values cannot bypass the per-email cap", async () => {
    armCountingRateLimiter();
    const { POST } = await loadRoute();

    // Attacker rotates the value they prepend; the ALB appends their real IP
    // as the rightmost hop. Neither the email bucket (no IP at all) nor the
    // rightmost-hop bucket varies, so request 6 of 6 is refused.
    const responses: Response[] = [];
    for (let i = 1; i <= 6; i += 1) {
      responses.push(
        await POST(
          signinEmailRequest("tester@example.com", {
            "x-forwarded-for": `198.51.100.${i}, 203.0.113.7`,
          }),
          ctx,
        ),
      );
    }

    expect(responses.slice(0, 5).map((r) => r.status)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    expect(responses[5]!.status).toBe(429);
    expect(nextAuthHandler).toHaveBeenCalledTimes(5);
  });

  it("the email-only bucket trips at N even across genuinely distinct client IPs", async () => {
    const counts = armCountingRateLimiter();
    const { POST } = await loadRoute();

    // Distributed requester: every request arrives from a different real IP
    // (distinct rightmost hops), so each email:IP bucket stays fresh — the
    // per-email bucket must still cap the recipient's mail volume.
    const responses: Response[] = [];
    for (let i = 1; i <= 6; i += 1) {
      responses.push(
        await POST(
          signinEmailRequest("tester@example.com", {
            "x-forwarded-for": `203.0.113.${i}`,
          }),
          ctx,
        ),
      );
    }

    expect(responses[5]!.status).toBe(429);
    expect(counts.get("magic-link-email:tester@example.com")).toBe(6);
    // Every IP-dimension bucket saw exactly one request.
    for (let i = 1; i <= 6; i += 1) {
      expect(
        counts.get(`magic-link:tester@example.com:203.0.113.${i}`),
      ).toBe(1);
    }
  });

  it("returns a next-auth-shaped 429 with RateLimited error when the email cap is hit", async () => {
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
    checkRateLimit
      .mockResolvedValueOnce(blockedRate())
      .mockResolvedValueOnce(allowedRate());
    const { POST } = await loadRoute();

    const res = await POST(signinEmailRequest("tester@example.com"), ctx);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("540");
    const body = (await res.json()) as { url: string };
    expect(body.url).toBe("http://localhost:3000/login?error=RateLimited");
    expect(nextAuthHandler).not.toHaveBeenCalled();
  });

  it("falls back to an 'unknown' hop when no forwarding header exists", async () => {
    checkRateLimit
      .mockResolvedValueOnce(allowedRate())
      .mockResolvedValueOnce(allowedRate());
    const { POST } = await loadRoute();

    await POST(signinEmailRequest("tester@example.com"), ctx);

    expect(checkRateLimit.mock.calls[1]![1]).toBe(
      "magic-link:tester@example.com:unknown",
    );
  });

  it("leaves non-email auth POSTs (e.g. the github signin) alone", async () => {
    const { POST } = await loadRoute();

    const res = await POST(
      new Request("http://localhost:3000/api/auth/signin/github", {
        method: "POST",
        body: "csrfToken=csrf",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      { params: Promise.resolve({ nextauth: ["signin", "github"] }) },
    );

    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(nextAuthHandler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("lets next-auth reject a bodyless email signin instead of rate limiting it", async () => {
    const { POST } = await loadRoute();

    await POST(
      new Request("http://localhost:3000/api/auth/signin/email", {
        method: "POST",
      }),
      ctx,
    );

    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(nextAuthHandler).toHaveBeenCalledTimes(1);
  });
});
