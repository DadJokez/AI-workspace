"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchJson } from "@/lib/client-api";

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
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
    try {
      if (status === "deployed") {
        await fetchJson(
          `/api/apps/${appId}/publication`,
          { method: "DELETE" },
          "Could not unpublish the app.",
        );
      } else {
        await fetchJson(
          `/api/apps/${appId}/deploy`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              appVersionId: liveVersionId,
              dataMode,
            }),
          },
          "Could not republish the app.",
        );
      }
      router.refresh();
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Could not update the app.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (status !== "deployed" && status !== "unpublished") return null;

  return (
    <div className="flex flex-col items-start gap-1">
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
      {error ? <span className="text-2xs text-danger">{error}</span> : null}
    </div>
  );
}
