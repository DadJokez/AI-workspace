import React from "react";

export interface DialogProps {
  /** Visibility (controlled). */
  open: boolean;
  /** Called on scrim click, Escape, or a close action. */
  onClose?: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Footer node — typically Button actions, right-aligned. */
  footer?: React.ReactNode;
  /** Max width in px. @default 460 */
  width?: number;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/** Centered modal with scrim. Closes on scrim click & Escape. */
export function Dialog(props: DialogProps): JSX.Element | null;
