"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchJson } from "@/lib/client-api";

export function EditAppButton({ appId }: { appId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleEdit() {
    setBusy(true);
    setNotice(null);
    try {
      const body = await fetchJson<{
        url?: string;
      }>(
        `/api/apps/${appId}/edit-sessions`,
        { method: "POST" },
        "Could not start editing.",
      );
      if (!body.url) {
        throw new Error("The edit session was created without a URL.");
      }
      router.push(body.url);
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : "Could not start editing.",
      );
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
        className="rounded-md border border-hairline px-3 py-1.5 text-sm font-medium text-ink hover:bg-ink/5 disabled:opacity-50"
      >
        {busy ? "Opening..." : "Edit with Comparative"}
      </button>
      {notice ? <p className="text-xs text-muted">{notice}</p> : null}
    </div>
  );
}
