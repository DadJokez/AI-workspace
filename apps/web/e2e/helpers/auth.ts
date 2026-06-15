import type { Page } from "@playwright/test";
import { encode } from "next-auth/jwt";

export const authSmokeUser = {
  id: "00000000-0000-4000-8000-000000000203",
  ghSub: "auth-smoke-github-subject",
  email: "auth-smoke@example.com",
  displayName: "Auth Smoke",
  role: "admin" as const,
};

const defaultSecret = "playwright-local-secret-with-enough-length";

export async function installAuthSmokeSession(page: Page) {
  const baseUrl =
    process.env.PLAYWRIGHT_BASE_URL ??
    `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  const url = new URL(baseUrl);
  const secret = process.env.NEXTAUTH_SECRET ?? defaultSecret;
  const maxAge = 60 * 60;
  const expires = Math.floor(Date.now() / 1000) + maxAge;
  const token = await encode({
    secret,
    maxAge,
    token: {
      sub: authSmokeUser.ghSub,
      ghSub: authSmokeUser.ghSub,
      userId: authSmokeUser.id,
      role: authSmokeUser.role,
      email: authSmokeUser.email,
      name: authSmokeUser.displayName,
      iat: Math.floor(Date.now() / 1000),
      exp: expires,
    },
  });

  await page.context().addCookies([
    {
      name:
        url.protocol === "https:"
          ? "__Secure-next-auth.session-token"
          : "next-auth.session-token",
      value: token,
      url: baseUrl,
      httpOnly: true,
      sameSite: "Lax",
      secure: url.protocol === "https:",
      expires,
    },
  ]);
}
