import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Gate `/admin/*` to `role = 'admin'`.
 *
 * Edge runtime can't open a postgres connection, so we delegate the role
 * lookup to `/api/me` (Node runtime, hits the DB). The session cookie/header
 * is forwarded so the API sees the same identity as the page request.
 *
 * Defense in depth — `app/admin/layout.tsx` also runs the role check
 * server-side; this middleware is the early redirect.
 */
export async function middleware(req: NextRequest) {
  if (!req.nextUrl.pathname.startsWith("/admin")) {
    return NextResponse.next();
  }

  const meUrl = new URL("/api/me", req.url);
  const meReq = new Request(meUrl, {
    headers: {
      cookie: req.headers.get("cookie") ?? "",
      // Forward auth-relevant headers; `/api/me` itself reads identity via
      // `getCurrentUser`, which today is env-driven and ignores the request.
      authorization: req.headers.get("authorization") ?? "",
    },
  });

  let role: string | undefined;
  try {
    const res = await fetch(meReq);
    if (res.ok) {
      const json = (await res.json()) as { user?: { role?: string } };
      role = json.user?.role;
    }
  } catch {
    // Fall through to the redirect on any failure — the layout-level check
    // will produce a useful error if it's a real outage rather than auth.
  }

  if (role !== "admin") {
    const url = req.nextUrl.clone();
    url.pathname = "/chat";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};
