import { afterEach, describe, expect, it, vi } from "vitest";

// `next-auth/jwt`.getToken is mocked per-test. Hoisting via vi.mock so the
// import in middleware.ts picks up our stub.
const getTokenMock = vi.fn();
vi.mock("next-auth/jwt", () => ({
  getToken: (...args: unknown[]) => getTokenMock(...args),
}));

import { middleware } from "@/middleware";

const ORIGINAL_ENV = {
  LEGACY_HOST_REDIRECT_FROM: process.env.LEGACY_HOST_REDIRECT_FROM,
  NEXTAUTH_URL: process.env.NEXTAUTH_URL,
};

function makeReq(pathname: string, cookieHeader = "", host = "localhost") {
  const base = `http://${host}${pathname}`;
  const url = new URL(base);
  const nextUrl = Object.assign(url, {
    clone: () => new URL(base),
  });
  return {
    nextUrl,
    url: url.toString(),
    headers: new Headers({ cookie: cookieHeader, host }),
  } as unknown as Parameters<typeof middleware>[0];
}

afterEach(() => {
  getTokenMock.mockReset();
  restoreEnv("LEGACY_HOST_REDIRECT_FROM", ORIGINAL_ENV.LEGACY_HOST_REDIRECT_FROM);
  restoreEnv("NEXTAUTH_URL", ORIGINAL_ENV.NEXTAUTH_URL);
});

describe("middleware — auth gate", () => {
  it("redirects unauthenticated /chat to /login with callbackUrl", async () => {
    getTokenMock.mockResolvedValueOnce(null);
    const res = await middleware(makeReq("/chat"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://localhost/login?callbackUrl=%2Fchat",
    );
  });

  it("redirects unauthenticated / to /login", async () => {
    getTokenMock.mockResolvedValueOnce(null);
    const res = await middleware(makeReq("/"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://localhost/login?callbackUrl=%2F",
    );
  });

  it("redirects unauthenticated /admin to /login", async () => {
    getTokenMock.mockResolvedValueOnce(null);
    const res = await middleware(makeReq("/admin/users"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://localhost/login?callbackUrl=%2Fadmin%2Fusers",
    );
  });

  it("redirects role=user away from /admin to /chat", async () => {
    getTokenMock.mockResolvedValueOnce({ role: "user", userId: "u1" });
    const res = await middleware(makeReq("/admin"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/chat");
  });

  it("lets role=admin through to /admin", async () => {
    getTokenMock.mockResolvedValueOnce({ role: "admin", userId: "u1" });
    const res = await middleware(makeReq("/admin"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("lets authenticated users through to /chat", async () => {
    getTokenMock.mockResolvedValueOnce({ role: "user", userId: "u1" });
    const res = await middleware(makeReq("/chat"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects the legacy production host to the canonical host", async () => {
    process.env.LEGACY_HOST_REDIRECT_FROM = "ai-workspace.builtwithrobot.link";
    process.env.NEXTAUTH_URL = "https://comparative.builtwithrobot.link";

    const res = await middleware(
      makeReq(
        "/chat?tab=latest",
        "",
        "ai-workspace.builtwithrobot.link",
      ),
    );

    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(
      "https://comparative.builtwithrobot.link/chat?tab=latest",
    );
    expect(getTokenMock).not.toHaveBeenCalled();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
