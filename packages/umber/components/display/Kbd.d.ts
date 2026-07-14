import React from "react";

export interface KbdProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "style"> {
  /** One key (string) or several (array) rendered as separate caps. */
  children: React.ReactNode | React.ReactNode[];
  style?: React.CSSProperties;
}

/** Keyboard key / shortcut display. */
export function Kbd(props: KbdProps): JSX.Element;
