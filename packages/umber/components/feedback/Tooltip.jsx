import React from "react";

/** Tooltip — hover/focus label. CSS-positioned; no portal. Wrap any trigger. */
export function Tooltip({ children, content, side = "top", style }) {
  const [open, setOpen] = React.useState(false);
  const pos = {
    top:    { bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)" },
    bottom: { top: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)" },
    left:   { right: "calc(100% + 6px)", top: "50%", transform: "translateY(-50%)" },
    right:  { left: "calc(100% + 6px)", top: "50%", transform: "translateY(-50%)" },
  }[side];

  return (
    <span style={{ position: "relative", display: "inline-flex", ...style }}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
      {children}
      <span role="tooltip" style={{
        position: "absolute", ...pos, zIndex: 50,
        padding: "5px 9px",
        background: "var(--neutral-900)", color: "var(--neutral-50)",
        border: "1px solid var(--neutral-700)",
        borderRadius: "var(--radius-sm)",
        fontFamily: "var(--font-sans)", fontSize: "var(--text-xs)", fontWeight: "var(--fw-medium)",
        whiteSpace: "nowrap", pointerEvents: "none",
        boxShadow: "var(--shadow-md)",
        opacity: open ? 1 : 0,
        transform: `${pos.transform} translateY(${open ? "0" : side === "top" ? "2px" : "-2px"})`,
        transition: "opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)",
      }}>{content}</span>
    </span>
  );
}
