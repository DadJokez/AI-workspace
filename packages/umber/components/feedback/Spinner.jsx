import React from "react";

/**
 * Spinner — quiet indeterminate progress. Inherits `currentColor`, so it takes
 * the tone of whatever it sits inside. Pure SVG (no keyframes) so it animates
 * anywhere, including inside buttons and inline with text.
 */
export function Spinner({ size = 16, strokeWidth = 2.5, label = "Loading", style, ...rest }) {
  const r = 12 - strokeWidth;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="status" aria-label={label}
      style={{ display: "block", flexShrink: 0, ...style }} {...rest}>
      <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeWidth={strokeWidth} opacity="0.18" />
      <path d={`M12 ${12 - r} a${r} ${r} 0 0 1 ${r} ${r}`} fill="none" stroke="currentColor"
        strokeWidth={strokeWidth} strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.7s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}
