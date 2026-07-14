import React from "react";

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "style"> {
  /** Label text beside the box. */
  label?: string;
  /** Secondary description below the label. */
  description?: string;
  style?: React.CSSProperties;
}

/** A checkbox with optional label and description. Controlled or uncontrolled. */
export function Checkbox(props: CheckboxProps): JSX.Element;
