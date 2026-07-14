import React from "react";

export interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "style"> {
  /** @default "ghost" */
  variant?: "ghost" | "outline" | "solid";
  /** @default "md" */
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  /** Required for accessibility — the action this button performs. */
  "aria-label": string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/** A square, icon-only action. Always give it an `aria-label`. */
export function IconButton(props: IconButtonProps): JSX.Element;
