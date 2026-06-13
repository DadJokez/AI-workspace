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
  const canonicalRedirect = redirectLegacyHost(req);
  if (canonicalRedirect) return canonicalRedirect;

  const isProtectedRoute =
    pathname === "/" ||
    pathname.startsWith("/chat") ||
    pathname.startsWith("/admin");
  if (!isProtectedRoute) return NextResponse.next();

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
  // Run on user-facing pages so legacy-host redirects work before the auth
  // gate. API routes and Next static assets are excluded.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};

function redirectLegacyHost(req: NextRequest): NextResponse | null {
  const legacyHost = normalizeHost(process.env.LEGACY_HOST_REDIRECT_FROM);
  if (!legacyHost) return null;

  const canonical = process.env.NEXTAUTH_URL?.replace(/\/$/, "");
  if (!canonical) return null;

  const requestHost = normalizeHost(
    req.headers.get("x-forwarded-host") ??
      req.headers.get("host") ??
      req.nextUrl.host,
  );
  if (requestHost !== legacyHost) return null;

  const url = new URL(req.nextUrl.pathname + req.nextUrl.search, canonical);
  return NextResponse.redirect(url, 308);
}

function normalizeHost(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}
