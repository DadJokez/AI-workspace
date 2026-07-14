import React from "react";

export interface SpinnerProps
  extends Omit<React.SVGProps<SVGSVGElement>, "style"> {
  /** Pixel diameter. @default 16 */
  size?: number;
  /** Ring thickness. @default 2.5 */
  strokeWidth?: number;
  /** Accessible label. @default "Loading" */
  label?: string;
  style?: React.CSSProperties;
}

/** Quiet indeterminate progress ring; inherits currentColor. */
export function Spinner(props: SpinnerProps): JSX.Element;
