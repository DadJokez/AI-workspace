"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function AdminAppPublicationActions({
  appId,
  status,
  liveVersionId,
  dataMode,
}: {
  appId: string;
  status: string;
  liveVersionId: string | null;
  dataMode: "snapshot" | "live_via_viewer";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function mutate() {
    if (
      status === "deployed" &&
      !window.confirm(
        "Unpublish this app now? The stable URL and content will be retained.",
      )
    ) {
      return;
    }
    if (status === "unpublished" && !liveVersionId) return;
    setBusy(true);
    try {
      const res =
        status === "deployed"
          ? await fetch(`/api/apps/${appId}/publication`, {
              method: "DELETE",
            })
          : await fetch(`/api/apps/${appId}/deploy`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                appVersionId: liveVersionId,
                dataMode,
              }),
            });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (status !== "deployed" && status !== "unpublished") return null;

  return (
    <button
      type="button"
      disabled={busy}
      onClick={mutate}
      className="rounded-md border border-hairline px-2 py-1 text-xs text-ink hover:bg-ink/5 disabled:opacity-50"
    >
      {busy
        ? status === "deployed"
          ? "Unpublishing…"
          : "Republishing…"
        : status === "deployed"
          ? "Unpublish"
          : "Republish"}
    </button>
  );
}
