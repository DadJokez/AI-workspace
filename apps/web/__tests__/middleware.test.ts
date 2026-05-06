import { afterEach, describe, expect, it, vi } from "vitest";
import { middleware } from "@/middleware";

function makeReq(pathname: string, cookieHeader = "") {
  // NextRequest is structurally compatible with what `middleware` reads:
  // `nextUrl` (with a `clone()` that returns a mutable URL), the request
  // URL string, and a Headers bag. We hand-roll the minimum used.
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
  vi.unstubAllGlobals();
});

describe("middleware — /admin gate", () => {
  it("passes through non-/admin paths without calling /api/me", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await middleware(makeReq("/chat"));
    expect(fetchSpy).not.toHaveBeenCalled();
    // NextResponse.next() doesn't redirect.
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects role=user away from /admin to /chat", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ user: { role: "user" } }), {
          status: 200,
        }),
      ),
    );

    const res = await middleware(makeReq("/admin"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/chat");
  });

  it("redirects unauthenticated requests away from /admin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );

    const res = await middleware(makeReq("/admin/users"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/chat");
  });

  it("lets role=admin through to /admin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ user: { role: "admin" } }), {
          status: 200,
        }),
      ),
    );

    const res = await middleware(makeReq("/admin"));
    // NextResponse.next() — no Location header.
    expect(res.headers.get("location")).toBeNull();
  });
});
