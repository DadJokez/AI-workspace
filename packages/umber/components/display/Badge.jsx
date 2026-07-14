import React from "react";

const TONES = {
  neutral: { bg: "var(--surface-inset)", fg: "var(--text-muted)", bd: "var(--border)" },
  accent:  { bg: "var(--tan-100)", fg: "var(--tan-800)", bd: "var(--tan-300)" },
  pop:     { bg: "var(--forest-100)", fg: "var(--forest-700)", bd: "var(--forest-200)" },
  success: { bg: "var(--success-bg)", fg: "var(--success)", bd: "transparent" },
  warning: { bg: "var(--warning-bg)", fg: "var(--warning)", bd: "transparent" },
  danger:  { bg: "var(--danger-bg)", fg: "var(--danger)", bd: "transparent" },
};

/** Badge — compact status/label chip. Optional leading dot for live states. */
export function Badge({ children, tone = "neutral", dot = false, style, ...rest }) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "var(--space-2)",
      padding: "2px 8px", height: "20px",
      background: t.bg, color: t.fg,
      border: `1px solid ${t.bd}`,
      borderRadius: "var(--radius-full)",
      fontFamily: "var(--font-sans)", fontSize: "var(--text-xs)",
      fontWeight: "var(--fw-medium)", letterSpacing: "var(--tracking-snug)",
      whiteSpace: "nowrap", lineHeight: 1,
      ...style,
    }} {...rest}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: "999px", background: "currentColor", flexShrink: 0 }} />}
      {children}
    </span>
  );
}
