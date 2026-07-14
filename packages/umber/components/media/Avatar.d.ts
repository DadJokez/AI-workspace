import React from "react";

export interface AvatarProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "style"> {
  /** Full name — used for initials fallback and image alt text. */
  name?: string;
  /** Image URL. Takes precedence over icon/initials. */
  src?: string;
  /** Lucide icon name to render instead of initials (for agents/apps). */
  icon?: string;
  /** Pixel diameter. @default 32 */
  size?: number;
  /** @default "circle" */
  shape?: "circle" | "square";
  /** @default "neutral" */
  tone?: "neutral" | "tan" | "pop" | "accent";
  style?: React.CSSProperties;
}

/** Identity token for people, agents & apps — image, glyph, or initials. */
export function Avatar(props: AvatarProps): JSX.Element;
