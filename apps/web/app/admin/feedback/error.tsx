"use client";

import { useEffect } from "react";

export default function AdminFeedbackError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    console.error("[admin-feedback-load-error]", error);
  }, [error]);

  return (
    <section className="px-4 py-8 sm:px-6" role="alert">
      <h2 className="text-base font-semibold text-ink">
        Feedback could not be loaded
      </h2>
      <p className="mt-1 max-w-xl text-sm text-muted">
        The feedback log is temporarily unavailable. Retry the request; no
        reports were changed.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-4 rounded-md border border-hairline bg-canvas px-3 py-1.5 text-sm font-medium text-ink hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
      >
        Try again
      </button>
    </section>
  );
}
