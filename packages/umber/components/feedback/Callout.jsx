import React from "react";

const TONES = {
  neutral: { bg: "var(--surface-inset)", bar: "var(--border-strong)", icon: "var(--text-muted)" },
  accent:  { bg: "var(--tan-50)", bar: "var(--tan-500)", icon: "var(--tan-700)" },
  info:    { bg: "var(--surface-inset)", bar: "var(--text-subtle)", icon: "var(--text-muted)" },
  success: { bg: "var(--success-bg)", bar: "var(--success)", icon: "var(--success)" },
  warning: { bg: "var(--warning-bg)", bar: "var(--warning)", icon: "var(--warning)" },
  danger:  { bg: "var(--danger-bg)", bar: "var(--danger)", icon: "var(--danger)" },
};

/**
 * Callout — an inline notice block. A tinted surface with a leading accent
 * bar and optional icon. Umber uses these instead of loud toast banners.
 */
export function Callout({ children, tone = "neutral", title, icon, style, ...rest }) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <div role="note" style={{
      display: "flex", gap: "var(--space-3)",
      padding: "var(--space-4)",
      background: t.bg,
      borderRadius: "var(--radius-md)",
      borderLeft: `3px solid ${t.bar}`,
      color: "var(--text)",
      ...style,
    }} {...rest}>
      {icon && <span style={{ display: "inline-flex", flexShrink: 0, color: t.icon, marginTop: 1 }}>{icon}</span>}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", minWidth: 0 }}>
        {title && <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--fw-semibold)", color: "var(--text)" }}>{title}</div>}
        <div style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)", lineHeight: "var(--leading-normal)" }}>{children}</div>
      </div>
    </div>
  );
}
