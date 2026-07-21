"use client";

import Link from "next/link";
import type { ReactNode } from "react";

type EmptyStateAction =
  | { actionHref: string; onAction?: never }
  | { actionHref?: never; onAction: () => void };

interface EmptyStateProps {
  title: string;
  description: string;
  actionLabel: string;
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  description,
  actionLabel,
  icon,
  className = "",
  ...action
}: EmptyStateProps & EmptyStateAction) {
  const actionClassName =
    "inline-flex min-h-9 items-center justify-center rounded-md bg-pop px-3 py-1.5 text-sm font-medium text-on-pop hover:opacity-90";

  return (
    <div
      data-testid="empty-state"
      className={`flex min-h-44 flex-col items-center justify-center px-4 py-8 text-center ${className}`.trim()}
    >
      <div className="mb-3 flex h-9 w-9 items-center justify-center text-muted">
        {icon ?? <InboxIcon />}
      </div>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>
      <div className="mt-4">
        {action.actionHref ? (
          <Link href={action.actionHref} className={actionClassName}>
            {actionLabel}
          </Link>
        ) : (
          <button
            type="button"
            onClick={action.onAction}
            className={actionClassName}
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function InboxIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="28"
      height="28"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 5.5h16v13H4z" />
      <path d="M4 14h4l1.5 2h5L16 14h4" />
    </svg>
  );
}
