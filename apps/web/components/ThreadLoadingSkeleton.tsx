export function ThreadLoadingSkeleton() {
  return (
    <div
      data-testid="thread-loading-skeleton"
      role="status"
      aria-label="Loading conversation"
      className="flex w-full flex-col gap-7 py-2"
    >
      <div className="ml-auto flex w-3/5 max-w-md flex-col items-end gap-2">
        <span className="thread-loading-shimmer block h-10 w-full rounded-md" />
      </div>
      <div className="flex w-4/5 max-w-xl flex-col gap-2.5">
        <span className="thread-loading-shimmer block h-3 w-28 rounded" />
        <span className="thread-loading-shimmer block h-4 w-full rounded" />
        <span className="thread-loading-shimmer block h-4 w-5/6 rounded" />
        <span className="thread-loading-shimmer block h-4 w-2/3 rounded" />
      </div>
      <div className="ml-auto flex w-1/2 max-w-sm flex-col items-end gap-2">
        <span className="thread-loading-shimmer block h-9 w-full rounded-md" />
      </div>
      <span className="sr-only">Loading conversation</span>
    </div>
  );
}
