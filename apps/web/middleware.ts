import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

/**
 * Auth gate for the app's primary surfaces.
 *
 * - `/`, `/chat/*`     → require any authenticated session; redirect to /login.
 * - `/admin/*`         → require role=admin; non-admins go to /chat,
 *                        unauthenticated to /login.
 *
 * `getToken` decodes the NextAuth JWT cookie locally on the edge — no
 * fetch loopback to `/api/me`. The role is stamped onto the token in the
 * `jwt` callback (apps/web/lib/auth/nextauth.ts), so it's available here
 * without a DB lookup. `app/admin/layout.tsx` re-checks server-side as
 * defense in depth.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isAdminRoute = pathname.startsWith("/admin");

  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET,
  });

  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search =
      pathname && pathname !== "/login"
        ? `?callbackUrl=${encodeURIComponent(pathname)}`
        : "";
    return NextResponse.redirect(url);
  }

  if (isAdminRoute && token.role !== "admin") {
    const url = req.nextUrl.clone();
    url.pathname = "/chat";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Protect the app's authenticated surfaces. `/login`, NextAuth's own
  // /api/auth/*, and Next's static assets (_next/*) are excluded so the
  // sign-in flow itself isn't gated.
  matcher: ["/", "/chat/:path*", "/admin/:path*"],
};
