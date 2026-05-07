import { afterEach, describe, expect, it, vi } from "vitest";

// `next-auth/jwt`.getToken is mocked per-test. Hoisting via vi.mock so the
// import in middleware.ts picks up our stub.
const getTokenMock = vi.fn();
vi.mock("next-auth/jwt", () => ({
  getToken: (...args: unknown[]) => getTokenMock(...args),
}));

import { middleware } from "@/middleware";

function makeReq(pathname: string, cookieHeader = "") {
  const base = `http://localhost${pathname}`;
  const url = new URL(base);
  const nextUrl = Object.assign(url, {
    clone: () => new URL(base),
  });
  return {
    nextUrl,
    url: url.toString(),
    headers: new Headers({ cookie: cookieHeader }),
  } as unknown as Parameters<typeof middleware>[0];
}

afterEach(() => {
  getTokenMock.mockReset();
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
});
