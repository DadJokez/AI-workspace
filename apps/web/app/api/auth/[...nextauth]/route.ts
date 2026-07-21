import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { getDb } from "@ai-workspace/db";
import {
  authOptions,
  magicLinkEmailRateLimitKey,
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
 * POST wrapper: rate-limit magic-link requests before next-auth sees them.
 * Two buckets, both consumed per request: the per-email bucket is the
 * enforcing cap (its key excludes client-supplied forwarding headers, so
 * rotating a spoofed X-Forwarded-For cannot bypass it); the email+IP bucket
 * is best-effort defense-in-depth keyed on the ALB-appended hop. Everything
 * else passes straight through. The 429 body mimics next-auth's JSON shape
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
  // Missing or syntactically invalid addresses can never pass the invite
  // gate, and next-auth's own normalizer rejects them — skip the store so
  // garbage input mints no rate_limit_buckets rows (same shape check as the
  // admin invitations route).
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;

  const db = getDb();
  // Primary cap first: spoof-proof, per recipient.
  const emailRate = await checkRateLimit(
    db,
    magicLinkEmailRateLimitKey(email),
    magicLinkRateLimit,
  );
  // Secondary best-effort dimension: per recipient + ALB-appended hop.
  const ipRate = await checkRateLimit(
    db,
    magicLinkRateLimitKey(email, req.headers.get("x-forwarded-for")),
    magicLinkRateLimit,
  );
  const rate = !emailRate.allowed ? emailRate : ipRate;
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
