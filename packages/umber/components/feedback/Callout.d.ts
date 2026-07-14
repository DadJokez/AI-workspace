import React from "react";

export interface CalloutProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "style" | "title"> {
  /** @default "neutral" */
  tone?: "neutral" | "accent" | "info" | "success" | "warning" | "danger";
  /** Bold title line above the body. */
  title?: React.ReactNode;
  /** Leading icon (Lucide <svg>, ~1em). */
  icon?: React.ReactNode;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/** Inline notice block — the calm alternative to a banner or toast. */
export function Callout(props: CalloutProps): JSX.Element;
