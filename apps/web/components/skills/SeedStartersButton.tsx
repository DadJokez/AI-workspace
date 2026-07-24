"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchJson } from "@/lib/client-api";

/** Admin-only one-click idempotent starter seeding (T207). */
export function SeedStartersButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleSeed() {
    setBusy(true);
    setNotice(null);
    try {
      await fetchJson(
        "/api/skills/seed",
        { method: "POST" },
        "Seeding failed.",
      );
      router.refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Seeding failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={handleSeed}
        disabled={busy}
        className="rounded-md border border-hairline px-3 py-1.5 text-sm text-ink hover:bg-ink/5 disabled:opacity-50"
      >
        {busy ? "Seeding…" : "Seed starter skills"}
      </button>
      {notice ? <p className="text-xs text-muted">{notice}</p> : null}
    </div>
  );
}
