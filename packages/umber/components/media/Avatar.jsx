import React from "react";
import { Icon } from "./Icon.jsx";

const TONES = {
  neutral: { bg: "var(--neutral-800)", fg: "var(--neutral-50)" },
  tan:     { bg: "var(--tan-200)", fg: "var(--neutral-900)" },
  pop:     { bg: "var(--forest-600)", fg: "#fff" },
  accent:  { bg: "var(--tan-100)", fg: "var(--tan-800)" },
};

function initials(name = "") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Avatar — identity token for people, agents & apps. Renders an image, a Lucide
 * glyph, or initials, as a circle (people) or gentle square (agents/apps).
 */
export function Avatar({ name = "", src, icon, size = 32, shape = "circle", tone = "neutral", style, ...rest }) {
  const t = TONES[tone] || TONES.neutral;
  const radius = shape === "square" ? "var(--radius-sm)" : "var(--radius-full)";
  const base = {
    width: size, height: size, flexShrink: 0, borderRadius: radius,
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    overflow: "hidden", fontFamily: "var(--font-sans)", fontWeight: "var(--fw-semibold)",
    fontSize: Math.round(size * 0.38), lineHeight: 1, userSelect: "none",
    background: t.bg, color: t.fg, ...style,
  };
  if (src) {
    return <span style={base} {...rest}><img src={src} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></span>;
  }
  return (
    <span style={base} {...rest}>
      {icon ? <Icon name={icon} size={Math.round(size * 0.5)} /> : initials(name)}
    </span>
  );
}
