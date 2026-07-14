import React from "react";

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  /** Field label rendered above the control. */
  label?: string;
  /** Helper text below the field. */
  hint?: string;
  /** Error message — overrides hint and turns the field red. */
  error?: string;
  /** @default "md" */
  size?: "sm" | "md" | "lg";
  /** Leading icon (Lucide <svg>, ~1em). */
  iconLeft?: React.ReactNode;
  /** Static leading text, e.g. "https://" (mono, muted). */
  prefix?: string;
  style?: React.CSSProperties;
}

/**
 * Single-line text field.
 * @startingPoint section="Forms" subtitle="Text fields with label, hint & error states" viewport="700x260"
 */
export function Input(props: InputProps): JSX.Element;
