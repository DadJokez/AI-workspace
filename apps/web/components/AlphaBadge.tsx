interface Props {
  placement?: "global" | "inline";
}

export function AlphaBadge({ placement = "global" }: Props) {
  return (
    <span
      aria-label="Alpha version"
      data-alpha-badge={placement}
      className={`pointer-events-none items-center rounded-full border border-hairline bg-surface text-2xs font-semibold uppercase leading-none text-muted shadow-sm ${
        placement === "global"
          ? "fixed left-1/2 top-[max(env(safe-area-inset-top),0.5rem)] z-[90] hidden -translate-x-1/2 px-2.5 py-1 md:inline-flex"
          : "inline-flex shrink-0 px-1.5 py-0.5 md:hidden"
      }`}
    >
      Alpha
    </span>
  );
}
