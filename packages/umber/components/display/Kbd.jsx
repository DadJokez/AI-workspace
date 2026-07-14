import React from "react";

/** Kbd — renders a keyboard key or shortcut. Pass keys as children (e.g. "⌘", "K"). */
export function Kbd({ children, style, ...rest }) {
  const keys = Array.isArray(children) ? children : [children];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "3px", ...style }} {...rest}>
      {keys.map((k, i) => (
        <kbd key={i} style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          minWidth: 20, height: 20, padding: "0 5px",
          background: "var(--surface)", color: "var(--text-muted)",
          border: "1px solid var(--border-strong)",
          borderBottomWidth: 2,
          borderRadius: "var(--radius-xs)",
          fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)",
          fontWeight: "var(--fw-medium)", lineHeight: 1,
        }}>{k}</kbd>
      ))}
    </span>
  );
}
