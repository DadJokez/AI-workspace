import React from "react";

export interface SwitchProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "size" | "style"> {
  /** @default "md" */
  size?: "sm" | "md";
  /** Optional label rendered to the right. */
  label?: string;
  style?: React.CSSProperties;
}

/** Instant on/off toggle for settings. Controlled or uncontrolled. */
export function Switch(props: SwitchProps): JSX.Element;
