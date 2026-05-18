"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
      const res = await fetch("/api/workflows/developer-briefing/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          retryRunId: runId,
          ...(modelId ? { modelId } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        run?: { id?: string };
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.run?.id) {
        throw new Error(data.message ?? data.error ?? "Retry failed.");
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
        className="rounded-md border border-ink bg-ink px-3 py-1.5 text-[12px] font-medium text-canvas disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Retrying..." : "Retry run"}
      </button>
      {error ? (
        <span className="text-[12px] text-red-300">{error}</span>
      ) : null}
    </div>
  );
}
