import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The [...nextauth] POST wrapper: magic-link requests are rate limited per
 * email+IP BEFORE next-auth sees them; every other auth POST passes through
 * untouched. Mirrors the inviteEmailRateLimit pattern.
 */

afterEach(() => {
  vi.resetModules();
  // clear (not restore): these module-level fns keep their implementations
  // across tests; only calls are wiped.
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const nextAuthHandler = vi.fn(
  async () => new Response("nextauth-handled", { status: 200 }),
);
const checkRateLimit = vi.fn();

async function loadRoute() {
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

function allowedRate() {
  return {
    allowed: true,
    limit: 5,
    remaining: 3,
    resetAt: new Date(Date.now() + 60_000),
    retryAfterSeconds: 60,
  };
}

function blockedRate() {
  return {
    allowed: false,
    limit: 5,
    remaining: 0,
    resetAt: new Date("2026-07-20T12:15:00Z"),
    retryAfterSeconds: 540,
  };
}

describe("[...nextauth] POST wrapper — magic-link rate limit", () => {
  it("keys the bucket on normalized email + first x-forwarded-for hop", async () => {
    checkRateLimit.mockResolvedValueOnce(allowedRate());
    const { POST } = await loadRoute();

    const res = await POST(
      signinEmailRequest(" Tester@Example.com ", {
        "x-forwarded-for": "203.0.113.9, 10.0.0.2",
      }),
      ctx,
    );

    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    expect(checkRateLimit.mock.calls[0]![1]).toBe(
      "magic-link:tester@example.com:203.0.113.9",
    );
    expect(checkRateLimit.mock.calls[0]![2]).toMatchObject({
      windowMs: 15 * 60 * 1000,
      maxRequests: 5,
    });
    // Allowed: delegated to next-auth with the body still readable.
    expect(nextAuthHandler).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("nextauth-handled");
  });

  it("returns a next-auth-shaped 429 with RateLimited error when over the limit", async () => {
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
    checkRateLimit.mockResolvedValueOnce(blockedRate());
    const { POST } = await loadRoute();

    const res = await POST(signinEmailRequest("tester@example.com"), ctx);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("540");
    const body = (await res.json()) as { url: string };
    expect(body.url).toBe("http://localhost:3000/login?error=RateLimited");
    expect(nextAuthHandler).not.toHaveBeenCalled();
  });

  it("falls back to an 'unknown' IP bucket when no forwarding header exists", async () => {
    checkRateLimit.mockResolvedValueOnce(allowedRate());
    const { POST } = await loadRoute();

    await POST(signinEmailRequest("tester@example.com"), ctx);

    expect(checkRateLimit.mock.calls[0]![1]).toBe(
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
