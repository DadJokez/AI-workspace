import React from "react";

export interface TagProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "style"> {
  /** When provided, renders a remove (×) button and calls this on click. */
  onRemove?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/** Rectangular, mono metadata token for filters, facets & keywords. */
export function Tag(props: TagProps): JSX.Element;
