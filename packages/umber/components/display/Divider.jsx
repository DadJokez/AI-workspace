import React from "react";

/** Divider — a hairline rule, horizontal or vertical, with an optional centered label. */
export function Divider({ orientation = "horizontal", label, style, ...rest }) {
  if (orientation === "vertical") {
    return <span role="separator" aria-orientation="vertical" style={{
      display: "inline-block", width: 1, alignSelf: "stretch",
      background: "var(--border)", ...style,
    }} {...rest} />;
  }
  if (label) {
    return (
      <div role="separator" style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", ...style }} {...rest}>
        <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-subtle)" }}>{label}</span>
        <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
      </div>
    );
  }
  return <hr role="separator" style={{ border: 0, height: 1, background: "var(--border)", margin: 0, ...style }} {...rest} />;
}
