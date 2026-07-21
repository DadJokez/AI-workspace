"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Owner-only archive control: the app stops serving; history persists. */
export function AppActions({ appId }: { appId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleArchive() {
    if (
      !window.confirm(
        "Archive this app? It stops serving immediately. Run history and the source conversation are kept.",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/apps/${appId}`, { method: "DELETE" });
      if (res.ok) {
        router.push("/apps");
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={handleArchive}
      className="rounded-md border border-hairline px-3 py-1.5 text-sm text-muted hover:text-ink disabled:opacity-50"
    >
      {busy ? "Archiving…" : "Archive app"}
    </button>
  );
}
