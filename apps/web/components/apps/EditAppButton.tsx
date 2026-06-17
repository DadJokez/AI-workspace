"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function EditAppButton({ appId }: { appId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleEdit() {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/apps/${appId}/edit-sessions`, {
        method: "POST",
      });
      const body = (await res.json()) as {
        url?: string;
        message?: string;
        error?: string;
      };
      if (res.ok && body.url) {
        router.push(body.url);
        return;
      }
      setNotice(body.message ?? body.error ?? "Could not start editing.");
    } catch {
      setNotice("Could not start editing.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={handleEdit}
        className="rounded-md border border-hairline px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/5 disabled:opacity-50"
      >
        {busy ? "Opening..." : "Edit"}
      </button>
      {notice ? <p className="text-[12px] text-muted">{notice}</p> : null}
    </div>
  );
}
