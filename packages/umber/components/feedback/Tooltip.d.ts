import React from "react";

export interface TooltipProps {
  /** The trigger element. */
  children: React.ReactNode;
  /** Tooltip label (kept short). */
  content: React.ReactNode;
  /** @default "top" */
  side?: "top" | "bottom" | "left" | "right";
  style?: React.CSSProperties;
}

/** Hover/focus label. Wrap any trigger element. */
export function Tooltip(props: TooltipProps): JSX.Element;
