import React from "react";

export interface BadgeProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "style"> {
  /** @default "neutral" */
  tone?: "neutral" | "accent" | "pop" | "success" | "warning" | "danger";
  /** Show a leading status dot. */
  dot?: boolean;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/** Compact status/label chip. */
export function Badge(props: BadgeProps): JSX.Element;
