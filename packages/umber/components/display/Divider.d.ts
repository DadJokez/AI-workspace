import React from "react";

export interface DividerProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "style"> {
  /** @default "horizontal" */
  orientation?: "horizontal" | "vertical";
  /** Centered label (horizontal only), rendered as a mono eyebrow. */
  label?: string;
  style?: React.CSSProperties;
}

/** Hairline separator, optionally labelled. */
export function Divider(props: DividerProps): JSX.Element;
