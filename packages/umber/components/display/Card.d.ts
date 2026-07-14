import React from "react";

export interface CardProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "style"> {
  /** Inner padding. @default "md" */
  padding?: "sm" | "md" | "lg";
  /** Lift + border emphasis on hover; use for clickable cards. */
  interactive?: boolean;
  /** Start with a raised shadow instead of the hairline default. */
  elevated?: boolean;
  /** Element tag. @default "div" */
  as?: keyof JSX.IntrinsicElements;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

export interface CardHeaderProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Trailing element (menu, button, badge). */
  action?: React.ReactNode;
  style?: React.CSSProperties;
}

/**
 * Primary surface container.
 * @startingPoint section="Display" subtitle="Content surface with header, padding & hover" viewport="700x260"
 */
export function Card(props: CardProps): JSX.Element;
export function CardHeader(props: CardHeaderProps): JSX.Element;
