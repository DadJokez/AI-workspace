"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchJson } from "@/lib/client-api";

/** Publication and archive controls. Both retain the app's URL and history. */
export function AppActions({
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
  const [busyAction, setBusyAction] = useState<
    "unpublish" | "republish" | "archive" | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleUnpublish() {
    if (
      !window.confirm(
        "Unpublish this app? Its URL and versions are kept, but viewers cannot open it until you republish.",
      )
    ) {
      return;
    }
    setBusyAction("unpublish");
    setNotice(null);
    try {
      await fetchJson(
        `/api/apps/${appId}/publication`,
        { method: "DELETE" },
        "Could not unpublish the app.",
      );
      router.refresh();
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : "Could not unpublish the app.",
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRepublish() {
    if (!liveVersionId) return;
    setBusyAction("republish");
    setNotice(null);
    try {
      await fetchJson(
        `/api/apps/${appId}/deploy`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ appVersionId: liveVersionId, dataMode }),
        },
        "Could not republish the app.",
      );
      router.refresh();
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : "Could not republish the app.",
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function handleArchive() {
    if (
      !window.confirm(
        "Archive this app? It stops serving immediately. Run history and the source conversation are kept.",
      )
    ) {
      return;
    }
    setBusyAction("archive");
    setNotice(null);
    try {
      await fetchJson(
        `/api/apps/${appId}`,
        { method: "DELETE" },
        "Could not archive the app.",
      );
      router.push("/apps");
      router.refresh();
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : "Could not archive the app.",
      );
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "deployed" ? (
        <button
          type="button"
          disabled={busyAction !== null}
          onClick={handleUnpublish}
          className="rounded-md border border-hairline px-3 py-1.5 text-sm text-ink hover:bg-ink/5 disabled:opacity-50"
        >
          {busyAction === "unpublish" ? "Unpublishing…" : "Unpublish"}
        </button>
      ) : status === "unpublished" && liveVersionId ? (
        <button
          type="button"
          disabled={busyAction !== null}
          onClick={handleRepublish}
          className="rounded-md border border-hairline px-3 py-1.5 text-sm font-medium text-ink hover:bg-ink/5 disabled:opacity-50"
        >
          {busyAction === "republish" ? "Republishing…" : "Republish"}
        </button>
      ) : null}
      <button
        type="button"
        disabled={busyAction !== null}
        onClick={handleArchive}
        className="rounded-md border border-hairline px-3 py-1.5 text-sm text-muted hover:text-ink disabled:opacity-50"
      >
        {busyAction === "archive" ? "Archiving…" : "Archive app"}
      </button>
      {notice ? <p className="text-xs text-muted">{notice}</p> : null}
    </div>
  );
}
