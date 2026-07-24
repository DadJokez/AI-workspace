"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchJson } from "@/lib/client-api";

export function RetryRunButton({
  runId,
  modelId,
}: {
  runId: string;
  modelId?: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setPending(true);
    setError(null);
    try {
      const data = await fetchJson<{
        run?: { id?: string };
      }>(
        "/api/workflows/developer-briefing/run",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            retryRunId: runId,
            ...(modelId ? { modelId } : {}),
          }),
        },
        "Retry failed.",
      );
      if (!data.run?.id) {
        throw new Error("The retry started without a run ID.");
      }
      router.push(`/admin/runs/${data.run.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={retry}
        disabled={pending}
        className="rounded-md border border-ink bg-ink px-3 py-1.5 text-xs font-medium text-canvas disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Retrying..." : "Retry run"}
      </button>
      {error ? (
        <span className="text-xs text-danger">{error}</span>
      ) : null}
    </div>
  );
}
