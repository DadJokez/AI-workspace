import React from "react";

export type ButtonVariant = "solid" | "accent" | "pop" | "outline" | "ghost" | "link";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "style"> {
  /** Visual style. `solid` = ink black (default action). `pop` = forest green — reserve for the single most important action per view. */
  variant?: ButtonVariant;
  /** Control height / type scale. @default "md" */
  size?: ButtonSize;
  /** Icon element rendered before the label (pass a Lucide <svg>, ~1em). */
  iconLeft?: React.ReactNode;
  /** Icon element rendered after the label. */
  iconRight?: React.ReactNode;
  /** Show a spinner and block interaction. */
  loading?: boolean;
  disabled?: boolean;
  /** Stretch to the container width. */
  fullWidth?: boolean;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/**
 * The primary action primitive for Umber.
 *
 * @startingPoint section="Forms" subtitle="Action buttons in every variant & size" viewport="700x200"
 */
export function Button(props: ButtonProps): JSX.Element;
