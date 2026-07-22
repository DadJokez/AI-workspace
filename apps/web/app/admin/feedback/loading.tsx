export default function AdminFeedbackLoading() {
  return (
    <section
      className="px-4 py-6 sm:px-6"
      aria-label="Loading feedback"
      aria-busy="true"
    >
      <div className="h-5 w-24 animate-pulse rounded bg-subtle" />
      <div className="mt-3 h-3 w-72 max-w-full animate-pulse rounded bg-subtle" />
      <div className="mt-6 flex gap-2">
        {[0, 1, 2, 3].map((item) => (
          <div
            key={item}
            className="h-7 w-20 animate-pulse rounded bg-subtle"
          />
        ))}
      </div>
      <div className="mt-5 h-28 animate-pulse rounded-md border border-hairline bg-surface" />
    </section>
  );
}
