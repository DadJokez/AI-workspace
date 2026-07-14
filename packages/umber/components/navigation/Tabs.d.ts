import React from "react";

export interface TabItem {
  value: string;
  label: React.ReactNode;
  /** Optional count/badge shown after the label. */
  badge?: React.ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  style?: React.CSSProperties;
}

/**
 * Underline tab bar. Controlled or uncontrolled.
 * @startingPoint section="Navigation" subtitle="Underline tab bar with counts" viewport="700x120"
 */
export function Tabs(props: TabsProps): JSX.Element;
