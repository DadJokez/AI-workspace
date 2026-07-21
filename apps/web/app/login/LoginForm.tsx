"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

interface Props {
  callbackUrl: string;
  /** Enabled provider ids from the AUTH_PROVIDERS allowlist (server-read). */
  providers: string[];
}

/**
 * Sign-in methods, driven by the server-side provider allowlist. Magic link
 * is the primary path; GitHub OAuth is the optional secondary.
 *
 * Anti-oracle: after submitting an email we show the SAME neutral "if that
 * address is invited, a link is on its way" state whether the server sent a
 * link or denied the request (AccessDenied) — the form must not reveal which
 * addresses exist or are invited.
 */
export function LoginForm({ callbackUrl, providers }: Props) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [linkState, setLinkState] = useState<"idle" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  const emailEnabled = providers.includes("email");
  const githubEnabled = providers.includes("github");

  if (!emailEnabled && !githubEnabled) {
    return (
      <p className="text-center text-[13px] text-muted">
        Sign-in is not configured. Contact an admin.
      </p>
    );
  }

  async function requestLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await signIn("email", {
        email,
        callbackUrl,
        redirect: false,
      });
      // AccessDenied (not invited) intentionally shows the neutral sent
      // state — no account-existence oracle.
      if (res?.ok || res?.error === "AccessDenied") {
        setLinkState("sent");
      } else if (res?.error === "RateLimited") {
        setError(
          "Too many sign-in links requested. Wait a few minutes and try again.",
        );
      } else {
        setError("Couldn't send the sign-in link. Try again in a moment.");
      }
    } catch {
      setError("Couldn't send the sign-in link. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  if (linkState === "sent") {
    return (
      <div className="flex flex-col gap-3 text-center">
        <p className="text-[13px] text-ink">
          If that address is invited, a sign-in link is on its way. It expires
          in 15 minutes.
        </p>
        <button
          type="button"
          onClick={() => {
            setLinkState("idle");
            setEmail("");
          }}
          className="text-[12px] text-muted underline underline-offset-2 hover:text-ink"
        >
          Use a different address
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {emailEnabled ? (
        <form onSubmit={requestLink} className="flex flex-col gap-2">
          <label
            htmlFor="login-email"
            className="text-[12px] font-medium text-ink"
          >
            Email address
          </label>
          <input
            id="login-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            className="w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-[13px] text-ink placeholder:text-muted"
          />
          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center rounded-md bg-ink px-4 py-2.5 text-[13px] font-semibold text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Sending…" : "Email me a sign-in link"}
          </button>
        </form>
      ) : null}

      {emailEnabled && githubEnabled ? (
        <div className="flex items-center gap-3 py-1">
          <span className="h-px flex-1 bg-hairline" aria-hidden="true" />
          <span className="text-[11px] uppercase tracking-wide text-muted">
            or
          </span>
          <span className="h-px flex-1 bg-hairline" aria-hidden="true" />
        </div>
      ) : null}

      {githubEnabled ? (
        <button
          type="button"
          onClick={() => {
            setBusy(true);
            void signIn("github", { callbackUrl });
          }}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-hairline bg-canvas px-4 py-2.5 text-[13px] font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
        >
          <GitHubIcon />
          <span>Sign in with GitHub</span>
        </button>
      ) : null}

      {error ? (
        <div className="rounded-md border border-hairline bg-canvas px-3 py-2 text-[12px] text-ink">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function GitHubIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
