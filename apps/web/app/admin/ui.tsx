import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared admin UI primitives. These were copy-pasted identically across several
 * /admin pages (runs, audit, tools, usage); centralized here so there's one
 * source of truth. Note: Metric, StatusBadge, and StatusDot were intentionally
 * left per-page — they've drifted into genuinely different variants (sizes,
 * status vocabularies) and normalizing them is a design-system task, not a
 * dedup, so it shouldn't ride along silently here.
 */

/** A filter chip used in the toolbar of admin list pages. */
export function FilterPill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-md border px-2.5 py-1 text-[12px] ${
        active
          ? "border-ink bg-ink text-canvas"
          : "border-hairline text-muted hover:bg-subtle hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}

/**
 * Human-readable label for a slug/provider. Superset of the per-page copies:
 * special-cases the two providers that have non-title casing, then falls back
 * to splitting on separators and capitalizing each word.
 */
export function titleize(value: string): string {
  const lower = value.toLowerCase();
  if (lower === "github") return "GitHub";
  if (lower === "ai-hub") return "Comparative";
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
