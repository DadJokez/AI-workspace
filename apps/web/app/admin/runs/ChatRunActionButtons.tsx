"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchJson } from "@/lib/client-api";

type Action = "cancel" | "retry" | "resume";

export function ChatRunActionButtons({
  runId,
  canCancel,
  canRetry,
  canResume,
}: {
  runId: string;
  canCancel?: boolean;
  canRetry?: boolean;
  canResume?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runAction(action: Action) {
    setPending(action);
    setError(null);
    try {
      const data = await fetchJson<{
        run?: { id?: string };
      }>(
        `/api/runs/${runId}/${action}`,
        { method: "POST" },
        `${action} failed.`,
      );
      if (!data.run?.id) {
        throw new Error(`${action} started without a run ID.`);
      }
      if (action === "retry") {
        router.push(`/admin/runs/${data.run.id}`);
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed.`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canCancel ? (
        <Button
          label="Cancel run"
          pendingLabel="Canceling..."
          pending={pending === "cancel"}
          disabled={pending !== null}
          onClick={() => runAction("cancel")}
        />
      ) : null}
      {canRetry ? (
        <Button
          label="Retry run"
          pendingLabel="Retrying..."
          pending={pending === "retry"}
          disabled={pending !== null}
          onClick={() => runAction("retry")}
        />
      ) : null}
      {canResume ? (
        <Button
          label="Resume"
          pendingLabel="Resuming..."
          pending={pending === "resume"}
          disabled={pending !== null}
          onClick={() => runAction("resume")}
        />
      ) : null}
      {error ? (
        <span className="text-xs text-danger">{error}</span>
      ) : null}
    </div>
  );
}

function Button({
  label,
  pendingLabel,
  pending,
  disabled,
  onClick,
}: {
  label: string;
  pendingLabel: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-hairline bg-canvas px-3 py-1.5 text-xs font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
