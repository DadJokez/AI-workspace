import { redirect } from "next/navigation";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ThinkingOrb } from "@/components/ThinkingOrb";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { enabledAuthProviders } from "@/lib/auth/nextauth";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}

export default async function LoginPage({ searchParams }: Props) {
  const sessionUser = await getSessionUser();
  const { callbackUrl, error } = await searchParams;
  if (sessionUser) {
    const target = sanitizeCallbackUrl(callbackUrl) ?? "/chat";
    redirect(target);
  }

  return (
    <div className="relative flex min-h-dvh w-full items-center justify-center bg-canvas px-6 text-ink">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm rounded-lg border border-hairline bg-surface px-6 py-8 shadow-sm">
        <div className="flex flex-col items-center gap-2 pb-6 text-center">
          <ThinkingOrb
            state="idle"
            size={40}
            stroke={13}
            label="Comparative"
            className="text-ink"
          />
          <h1 className="font-serif text-lg font-normal text-ink">
            Comparative
          </h1>
          <p className="text-sm text-muted">
            Sign in to continue to your workspace.
          </p>
        </div>

        <LoginForm
          callbackUrl={sanitizeCallbackUrl(callbackUrl) ?? "/chat"}
          providers={enabledAuthProviders()}
        />

        {error ? <ErrorMessage code={error} /> : null}

        <p className="pt-6 text-center text-2xs text-muted">
          Access is invite-only. Ask an admin to invite your email.
        </p>
      </div>
    </div>
  );
}

function ErrorMessage({ code }: { code: string }) {
  // NextAuth surfaces a small, fixed set of error codes via ?error=... on
  // the redirect back to the sign-in page. Map the common ones to plain
  // English; fall back to the raw code so we never silently eat one.
  const message =
    code === "AccessDenied"
      ? "This account isn't authorized. Ask an admin to invite your email."
      : code === "OAuthSignin" || code === "OAuthCallback"
        ? "Couldn't reach GitHub. Try again in a moment."
        : code === "Verification"
          ? "That sign-in link is invalid or has expired. Request a new one."
          : code === "EmailSignin"
            ? "Couldn't send the sign-in link. Try again in a moment."
            : code === "RateLimited"
              ? "Too many sign-in links requested. Wait a few minutes and try again."
              : code === "OAuthAccountNotLinked"
                ? "That sign-in method is linked to a different account."
                : code === "Configuration"
                  ? "Sign-in is misconfigured. Contact an admin."
                  : `Sign-in failed (${code}).`;
  return (
    <div className="mt-4 rounded-md border border-hairline bg-canvas px-3 py-2 text-xs text-ink">
      {message}
    </div>
  );
}

/**
 * Only allow same-origin paths as a callback. Prevents an attacker from
 * crafting `/login?callbackUrl=https://evil.example` and bouncing the user
 * off-site after sign-in.
 */
function sanitizeCallbackUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}
