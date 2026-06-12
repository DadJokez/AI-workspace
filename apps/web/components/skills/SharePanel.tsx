"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface ShareRow {
  id: string;
  grantedToEmail: string;
  grantedToName: string;
}

interface SharePanelProps {
  subjectType: "skill" | "app";
  subjectId: string;
  shares: ShareRow[];
}

/**
 * Owner-only sharing controls for skills and apps. A share grants run/open +
 * clone with the recipient's own credentials — never edit, never the owner's
 * tokens.
 */
export function SharePanel({ subjectType, subjectId, shares }: SharePanelProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noun = subjectType === "app" ? "app" : "skill";

  async function handleShare(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/shares", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectType, subjectId, email }),
      });
      const body = (await res.json()) as { message?: string; error?: string };
      if (res.ok) {
        setEmail("");
        router.refresh();
        return;
      }
      setNotice(body.message ?? body.error ?? `Could not share the ${noun}.`);
    } catch {
      setNotice(`Could not share the ${noun}.`);
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(shareId: string) {
    await fetch(`/api/shares/${shareId}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      {shares.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {shares.map((share) => (
            <li
              key={share.id}
              className="flex items-center justify-between rounded-md border border-hairline px-3 py-2 text-[12px]"
            >
              <span className="text-ink">
                {share.grantedToName}
                <span className="text-muted"> · {share.grantedToEmail}</span>
              </span>
              <button
                type="button"
                className="text-muted hover:text-ink"
                onClick={() => handleRevoke(share.id)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-muted">
          {subjectType === "app"
            ? "Not shared yet. Recipients can open the app behind workspace sign-in — they never get edit access or your credentials."
            : "Not shared yet. Recipients can run and clone it with their own credentials — never yours."}
        </p>
      )}

      <form onSubmit={handleShare} className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-[12px] text-muted">
          Share with (email)
          <input
            type="email"
            className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[13px] text-ink"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            required
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md border border-hairline px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/5 disabled:opacity-50"
        >
          {busy ? "Sharing…" : "Share"}
        </button>
      </form>
      {notice ? <p className="text-[12px] text-muted">{notice}</p> : null}
    </div>
  );
}
