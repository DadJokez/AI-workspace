import Link from "next/link";
import type { ReactNode } from "react";
import { percentOf, scaleBarValues } from "@/lib/admin-chart";

/**
 * Shared admin UI primitives. Admin pages use these variants so status color,
 * metric hierarchy, and chart behavior cannot drift between surfaces.
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
      className={`rounded-md border px-2.5 py-1 text-xs ${
        active
          ? "border-ink bg-ink text-canvas"
          : "border-hairline text-muted hover:bg-subtle hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}

type MetricVariant = "default" | "prominent" | "compact" | "grid";

export function Metric({
  label,
  value,
  hint,
  emphasis = false,
  variant = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  emphasis?: boolean;
  variant?: MetricVariant;
}) {
  const displayValue =
    value === undefined || value === null || value === "" ? "n/a" : value;

  if (variant === "grid") {
    return (
      <div className="min-w-0 border-b border-r border-hairline px-3 py-2.5">
        <dt className="text-2xs text-muted">{label}</dt>
        <dd className="mt-1 truncate text-xs font-medium text-ink">
          {displayValue}
        </dd>
      </div>
    );
  }

  const prominent = variant === "prominent";
  const compact = variant === "compact";
  return (
    <div
      className={`rounded-md border border-hairline bg-surface ${
        compact ? "px-3 py-2" : "px-4 py-3"
      }`}
    >
      <div className="text-2xs uppercase tracking-wider text-muted">
        {label}
      </div>
      <div
        className={`${compact ? "mt-1 truncate text-sm" : `mt-2 ${prominent ? "text-2xl" : "text-xl"}`} font-semibold ${
          emphasis ? "text-pop" : "text-ink"
        }`}
      >
        {displayValue}
      </div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

type StatusTone = "success" | "danger" | "warning" | "info" | "muted";

export function StatusBadge({
  status,
  label,
  variant = "solid",
}: {
  status: string;
  label?: string;
  variant?: "solid" | "outline";
}) {
  const tone = statusTone(status);
  const classes =
    variant === "outline" ? OUTLINE_STATUS_CLASSES[tone] : STATUS_CLASSES[tone];
  return (
    <span
      className={`inline-flex px-2 text-2xs uppercase tracking-wider ${
        variant === "outline" ? "rounded-md py-1" : "rounded py-0.5"
      } ${classes}`}
    >
      {label ?? status}
    </span>
  );
}

export function StatusDot({
  status,
  className = "",
}: {
  status: string;
  className?: string;
}) {
  const tone = statusTone(status);
  const active = ["pending", "queued", "running", "started"].includes(
    status.toLowerCase(),
  );
  return (
    <span
      aria-hidden="true"
      className={`h-2 w-2 shrink-0 rounded-full ${DOT_STATUS_CLASSES[tone]} ${
        active ? "animate-pulse" : ""
      } ${className}`.trim()}
    />
  );
}

interface BarDatum {
  label: string;
  value: number;
}

export function BarChart({
  data,
  ariaLabel,
  valueLabel = (value) => value.toLocaleString(),
  yGridlines = 0,
}: {
  data: readonly BarDatum[];
  ariaLabel: string;
  valueLabel?: (value: number) => string;
  yGridlines?: number;
}) {
  const heights = scaleBarValues(data.map((datum) => datum.value));
  const axisLabels = chartAxisLabels(data);

  return (
    <div role="img" aria-label={ariaLabel}>
      <div className="relative flex h-32 items-end gap-px border-b border-hairline">
        {Array.from({ length: Math.max(0, yGridlines) }, (_, index) => (
          <span
            key={index}
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 border-t border-hairline/60"
            style={{ bottom: `${((index + 1) / (yGridlines + 1)) * 100}%` }}
          />
        ))}
        {data.map((datum, index) => (
          <div
            key={`${datum.label}-${index}`}
            className="group relative z-[1] flex h-full min-w-[2px] flex-1 items-end"
            title={`${datum.label}: ${valueLabel(datum.value)}`}
          >
            <div
              className="w-full rounded-sm bg-ink/70 transition-colors group-hover:bg-ink"
              style={{
                height: `${Math.max(heights[index] === 0 ? 0 : 4, heights[index] ?? 0)}%`,
              }}
            />
          </div>
        ))}
      </div>
      {axisLabels.length > 0 ? (
        <div
          aria-hidden="true"
          className={`mt-1 flex text-2xs text-muted ${
            axisLabels.length === 1 ? "justify-center" : "justify-between"
          }`}
        >
          {axisLabels.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function BarRow({
  label,
  value,
  total,
}: {
  label: string;
  value: number;
  total: number;
}) {
  const percentage = percentOf(value, total);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="truncate text-ink">{label}</span>
        <span className="shrink-0 text-xs text-muted">
          {value.toLocaleString()} · {percentage}%
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-subtle">
        <div
          className="h-full rounded bg-ink/60"
          style={{
            width: `${Math.max(percentage === 0 ? 0 : 2, percentage)}%`,
          }}
        />
      </div>
    </div>
  );
}

const STATUS_CLASSES: Record<StatusTone, string> = {
  success: "bg-success-bg text-success",
  danger: "bg-danger-bg text-danger",
  warning: "bg-warning-bg text-warning",
  info: "bg-info-bg text-info",
  muted: "bg-subtle text-muted",
};

const OUTLINE_STATUS_CLASSES: Record<StatusTone, string> = {
  success: "border border-success/30 bg-success-bg text-success",
  danger: "border border-danger/30 bg-danger-bg text-danger",
  warning: "border border-warning/30 bg-warning-bg text-warning",
  info: "border border-info/30 bg-info-bg text-info",
  muted: "border border-hairline bg-canvas text-muted",
};

const DOT_STATUS_CLASSES: Record<StatusTone, string> = {
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
  info: "bg-info",
  muted: "bg-muted",
};

function statusTone(status: string): StatusTone {
  const normalized = status.toLowerCase();
  if (
    ["succeeded", "success", "completed", "active", "enabled", "fixed"].includes(
      normalized,
    )
  ) {
    return "success";
  }
  if (
    ["failed", "failure", "error", "disabled", "revoked", "high"].includes(
      normalized,
    )
  ) {
    return "danger";
  }
  if (["denied", "warning", "write", "medium"].includes(normalized)) {
    return "warning";
  }
  if (
    ["pending", "queued", "running", "started", "reviewing"].includes(
      normalized,
    )
  ) {
    return "info";
  }
  return "muted";
}

function chartAxisLabels(data: readonly BarDatum[]): string[] {
  if (data.length === 0) return [];
  const labels = [
    data[0]?.label,
    data[Math.floor((data.length - 1) / 2)]?.label,
    data.at(-1)?.label,
  ].filter((label): label is string => Boolean(label));
  return Array.from(new Set(labels));
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
