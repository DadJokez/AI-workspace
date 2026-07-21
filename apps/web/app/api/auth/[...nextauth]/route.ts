import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { getDb } from "@ai-workspace/db";
import {
  authOptions,
  magicLinkRateLimit,
  magicLinkRateLimitKey,
} from "@/lib/auth/nextauth";
import { checkRateLimit } from "@/lib/request-limits";

const handler = NextAuth(authOptions) as (
  req: Request,
  ctx: { params: Promise<{ nextauth: string[] }> },
) => Promise<Response>;

export { handler as GET };

/**
 * POST wrapper: rate-limit magic-link requests per normalized recipient email
 * before next-auth sees them. Everything else passes straight through. The
 * key intentionally excludes client-supplied forwarding headers so rotating
 * a spoofed X-Forwarded-For value cannot bypass the recipient cap. The 429
 * body mimics next-auth's JSON shape
 * (`{ url }`) so `signIn("email", { redirect: false })` surfaces it as
 * `error: "RateLimited"` for the login form. The limit runs before any
 * account lookup, so it reveals nothing about whether an address is invited.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ nextauth: string[] }> },
) {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/signin/email")) {
    const limited = await magicLinkRateLimited(req, url);
    if (limited) return limited;
  }
  return handler(req, ctx);
}

async function magicLinkRateLimited(
  req: Request,
  url: URL,
): Promise<Response | null> {
  // Clone: next-auth still needs to read the original form body.
  const form = await req
    .clone()
    .formData()
    .catch(() => null);
  const email = form?.get("email")?.toString().trim().toLowerCase() ?? "";
  if (!email) return null; // next-auth rejects the malformed request itself

  const rate = await checkRateLimit(
    getDb(),
    magicLinkRateLimitKey(email),
    magicLinkRateLimit,
  );
  if (rate.allowed) return null;

  const base = (process.env.NEXTAUTH_URL ?? url.origin).replace(/\/+$/, "");
  return NextResponse.json(
    { url: `${base}/login?error=RateLimited` },
    {
      status: 429,
      headers: {
        "Retry-After": String(rate.retryAfterSeconds),
        "X-RateLimit-Limit": String(rate.limit),
        "X-RateLimit-Remaining": String(rate.remaining),
        "X-RateLimit-Reset": rate.resetAt.toISOString(),
      },
    },
  );
}
