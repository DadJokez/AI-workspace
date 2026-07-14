import React from "react";

const PAD = { sm: "var(--space-4)", md: "var(--space-5)", lg: "var(--space-6)" };

/**
 * Card — the primary surface container. Umber cards lean on a hairline
 * border and a whisper of shadow rather than heavy elevation.
 */
export function Card({ children, padding = "md", interactive = false, elevated = false, as = "div", style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  const Tag = as;
  return (
    <Tag
      onMouseEnter={interactive ? () => setHover(true) : undefined}
      onMouseLeave={interactive ? () => setHover(false) : undefined}
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        padding: PAD[padding] || PAD.md,
        boxShadow: elevated ? "var(--shadow-md)" : "var(--shadow-xs)",
        transition: "border-color var(--dur-base) var(--ease-out), box-shadow var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out)",
        cursor: interactive ? "pointer" : "default",
        ...(interactive && hover ? { borderColor: "var(--border-strong)", boxShadow: "var(--shadow-md)", transform: "translateY(-1px)" } : null),
        ...style,
      }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** CardHeader — title + optional description and trailing action. */
export function CardHeader({ title, description, action, style }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--space-4)", marginBottom: "var(--space-4)", ...style }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
        {title && <div style={{ fontSize: "var(--text-lg)", fontWeight: "var(--fw-semibold)", letterSpacing: "var(--tracking-snug)", color: "var(--text)" }}>{title}</div>}
        {description && <div style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>{description}</div>}
      </div>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
  );
}
