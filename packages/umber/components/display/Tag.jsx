import React from "react";

/** Tag — a rectangular metadata token, optionally removable. For filters, facets, keywords. */
export function Tag({ children, onRemove, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "var(--space-2)",
      padding: "3px 8px", height: "24px",
      background: "var(--surface)", color: "var(--text)",
      border: "1px solid var(--border-strong)",
      borderRadius: "var(--radius-sm)",
      fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)",
      letterSpacing: "var(--tracking-snug)", whiteSpace: "nowrap", lineHeight: 1,
      ...style,
    }} {...rest}>
      {children}
      {onRemove && (
        <button aria-label="Remove" onClick={onRemove}
          onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 14, height: 14, marginRight: -2, padding: 0, border: "none",
            borderRadius: "var(--radius-xs)", cursor: "pointer",
            background: hover ? "var(--surface-active)" : "transparent",
            color: hover ? "var(--text)" : "var(--text-subtle)",
          }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </span>
  );
}
