import React from "react";

const SIZES = {
  sm: { height: "var(--control-h-sm)", padding: "0 var(--space-3)", fontSize: "var(--text-sm)", gap: "var(--space-2)", radius: "var(--radius-sm)" },
  md: { height: "var(--control-h-md)", padding: "0 var(--space-4)", fontSize: "var(--text-base)", gap: "var(--space-2)", radius: "var(--radius-sm)" },
  lg: { height: "var(--control-h-lg)", padding: "0 var(--space-5)", fontSize: "var(--text-md)", gap: "var(--space-3)", radius: "var(--radius-md)" },
};

const VARIANTS = {
  solid:   { background: "var(--action)", color: "var(--action-fg)", border: "1px solid var(--action)" },
  accent:  { background: "var(--accent)", color: "var(--accent-fg)", border: "1px solid var(--accent-strong)" },
  pop:     { background: "var(--pop)", color: "var(--pop-fg)", border: "1px solid var(--pop)" },
  outline: { background: "transparent", color: "var(--text)", border: "1px solid var(--border-strong)" },
  ghost:   { background: "transparent", color: "var(--text)", border: "1px solid transparent" },
  link:    { background: "transparent", color: "var(--link)", border: "1px solid transparent", padding: 0, height: "auto" },
};

/**
 * Button — the primary action primitive.
 * Reserve `pop` (forest green) for a single, most-important action per view.
 */
export function Button({
  children,
  variant = "solid",
  size = "md",
  iconLeft,
  iconRight,
  loading = false,
  disabled = false,
  fullWidth = false,
  type = "button",
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const [active, setActive] = React.useState(false);
  const s = SIZES[size] || SIZES.md;
  const v = VARIANTS[variant] || VARIANTS.solid;
  const isDisabled = disabled || loading;

  const hoverBg = {
    solid: "var(--action-hover)",
    accent: "var(--accent-strong)",
    pop: "var(--pop-hover)",
    outline: "var(--surface-hover)",
    ghost: "var(--surface-hover)",
    link: "transparent",
  }[variant];

  const base = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: s.gap,
    fontFamily: "var(--font-sans)",
    fontWeight: "var(--fw-medium)",
    fontSize: v.fontSize || s.fontSize,
    lineHeight: 1,
    letterSpacing: "var(--tracking-snug)",
    height: v.height || s.height,
    padding: v.padding !== undefined ? v.padding : s.padding,
    borderRadius: v.padding === 0 ? 0 : s.radius,
    cursor: isDisabled ? "not-allowed" : "pointer",
    userSelect: "none",
    whiteSpace: "nowrap",
    width: fullWidth ? "100%" : "auto",
    textDecoration: variant === "link" && hover ? "underline" : "none",
    textUnderlineOffset: "2px",
    transition: "background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out), opacity var(--dur-fast)",
    transform: active && !isDisabled ? "translateY(0.5px) scale(0.994)" : "none",
    opacity: isDisabled ? 0.5 : 1,
    ...v,
    ...(hover && !isDisabled ? { background: hoverBg, borderColor: variant === "outline" ? "var(--border-focus)" : hoverBg } : null),
    ...style,
  };

  return (
    <button
      type={type}
      disabled={isDisabled}
      style={base}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      {...rest}
    >
      {loading && <Spinner />}
      {!loading && iconLeft ? <span style={{ display: "inline-flex", marginLeft: "-2px" }}>{iconLeft}</span> : null}
      {children}
      {!loading && iconRight ? <span style={{ display: "inline-flex", marginRight: "-2px" }}>{iconRight}</span> : null}
    </button>
  );
}

function Spinner() {
  return (
    <span
      style={{
        width: "1em", height: "1em",
        border: "2px solid currentColor",
        borderTopColor: "transparent",
        borderRadius: "999px",
        display: "inline-block",
        animation: "umber-spin 0.6s linear infinite",
      }}
    >
      <style>{"@keyframes umber-spin{to{transform:rotate(360deg)}}"}</style>
    </span>
  );
}
