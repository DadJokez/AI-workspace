import React from "react";

export interface OrbProps {
  /** @default "idle" */
  state?: "idle" | "thinking" | "responding";
  /** Pixel diameter. @default 24 */
  size?: number;
  /** Stroke width in the 200×200 viewBox. @default 15 */
  stroke?: number;
  /** Monotonically increasing content length / token count; bumps drive the "responding" reaction. */
  energy?: number;
  /** @default true — set false for a settled static frame (also honors prefers-reduced-motion). */
  animated?: boolean;
  /** Accessible label; when set the mark is exposed as an image, otherwise hidden from AT. */
  label?: string;
  /** Tint — the mark inherits currentColor. */
  color?: string;
  style?: React.CSSProperties;
  className?: string;
}

/** The Comparative brand mark — a state-aware animated loop / AI-activity indicator. */
export function Orb(props: OrbProps): JSX.Element;
