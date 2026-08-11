import React from "react";

/** Names available in the bundled Lucide subset. Extend ICONS in Icon.jsx to add more. */
export type IconName =
  | "search" | "plus" | "x" | "check" | "check-circle" | "chevron-down" | "chevron-right"
  | "arrow-right" | "ellipsis" | "copy" | "info" | "alert-triangle" | "database" | "activity"
  | "settings" | "bar-chart" | "clock" | "play" | "external-link" | "folder" | "file-text"
  | "user" | "log-out" | "layers" | "zap" | "home" | "bell" | "filter" | "download" | "trash"
  | "git-branch" | "terminal" | "sparkles" | "circle" | "grid" | "link" | "moon" | "sun"
  | "globe" | "message-square";

export interface IconProps
  extends Omit<React.SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** Pixel size (width & height). @default 18 */
  size?: number;
  /** @default 2 */
  strokeWidth?: number;
}

/** Renders a Lucide glyph by name; inherits `currentColor`. */
export function Icon(props: IconProps): JSX.Element | null;
