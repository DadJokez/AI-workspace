"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
      const res = await fetch(`/api/runs/${runId}/${action}`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        run?: { id?: string };
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.run?.id) {
        throw new Error(data.message ?? data.error ?? `${action} failed.`);
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
        <span className="text-[12px] text-danger">{error}</span>
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
      className="rounded-md border border-hairline bg-canvas px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
