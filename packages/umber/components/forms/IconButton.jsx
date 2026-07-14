import React from "react";

const SIZES = {
  sm: { size: "28px", radius: "var(--radius-sm)" },
  md: { size: "34px", radius: "var(--radius-sm)" },
  lg: { size: "42px", radius: "var(--radius-md)" },
};

const VARIANTS = {
  ghost:   { background: "transparent", color: "var(--text-muted)", border: "1px solid transparent" },
  outline: { background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border-strong)" },
  solid:   { background: "var(--action)", color: "var(--action-fg)", border: "1px solid var(--action)" },
};

/** IconButton — a square, label-less action. Always pass `aria-label`. */
export function IconButton({
  children,
  variant = "ghost",
  size = "md",
  disabled = false,
  style,
  "aria-label": ariaLabel,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const s = SIZES[size] || SIZES.md;
  const v = VARIANTS[variant] || VARIANTS.ghost;
  const hoverBg = { ghost: "var(--surface-hover)", outline: "var(--surface-hover)", solid: "var(--action-hover)" }[variant];
  const hoverColor = variant === "ghost" ? "var(--text)" : undefined;

  return (
    <button
      aria-label={ariaLabel}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: s.size,
        height: s.size,
        borderRadius: s.radius,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast)",
        ...v,
        ...(hover && !disabled ? { background: hoverBg, color: hoverColor ?? v.color } : null),
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
