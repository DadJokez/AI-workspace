"use client";

interface AsyncStatusNoticeProps {
  message: string | null;
  onDismiss?: () => void;
  floating?: boolean;
}

/** A quiet, persistent live region for async failures that have no inline home. */
export function AsyncStatusNotice({
  message,
  onDismiss,
  floating = false,
}: AsyncStatusNoticeProps) {
  if (!message) return null;

  return (
    <div
      role="alert"
      className={
        floating
          ? "fixed bottom-4 left-1/2 z-[100] flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-3 rounded-md border border-danger/30 border-l-2 border-l-danger bg-danger-bg px-3 py-2 text-sm text-danger shadow-md"
          : "flex items-start gap-3 rounded-md border border-danger/30 border-l-2 border-l-danger bg-danger-bg px-3 py-2 text-sm text-danger"
      }
    >
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{message}</span>
      {onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss error"
          title="Dismiss"
          onClick={onDismiss}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-lg leading-none text-danger hover:bg-danger/10"
        >
          <span aria-hidden="true">&times;</span>
        </button>
      ) : null}
    </div>
  );
}
