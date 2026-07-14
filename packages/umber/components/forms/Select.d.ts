import React from "react";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  label?: string;
  hint?: string;
  error?: string;
  /** @default "md" */
  size?: "sm" | "md" | "lg";
  /** Options as strings or {value,label}. Ignored if `children` are provided. */
  options?: (string | SelectOption)[];
  /** Disabled first option shown when nothing is selected. */
  placeholder?: string;
  style?: React.CSSProperties;
}

/** Native <select> styled to the form family, with a custom chevron. */
export function Select(props: SelectProps): JSX.Element;
