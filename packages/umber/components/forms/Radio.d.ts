import React from "react";

export interface RadioOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface RadioGroupProps {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** Shared radio-group name; auto-generated if omitted. */
  name?: string;
  /** Convenience option list; alternatively pass <Radio> children. */
  options?: (string | RadioOption)[];
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export interface RadioProps {
  value: string;
  label?: string;
  description?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  /** Injected by RadioGroup — not set directly. */
  checked?: boolean;
  name?: string;
  onSelect?: (value: string) => void;
}

/** Single-choice group. Provide state via RadioGroup. */
export function RadioGroup(props: RadioGroupProps): JSX.Element;
/** One radio option; render inside a RadioGroup. */
export function Radio(props: RadioProps): JSX.Element;
