import React from "react";

export interface StudioMarkProps {
  /** @default "idle" */
  state?: "idle" | "working";
  /** Pixel size. @default 24 */
  size?: number;
  /** @default true — set false for a settled static frame. */
  animated?: boolean;
  /** Accessible label; when set the mark is exposed as an image, otherwise hidden from AT. */
  label?: string;
  /** Tint — the mark inherits currentColor. */
  color?: string;
  style?: React.CSSProperties;
  className?: string;
}

/** Comparative's open working-frame mark for Contribution Studio. */
export function StudioMark(props: StudioMarkProps): JSX.Element;
