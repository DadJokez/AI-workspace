export const SIDEBAR_COLLAPSED_STORAGE_KEY =
  "comparative.sidebar.collapsed";

const DESKTOP_MIN_WIDTH = 768;
const TABLET_RAIL_MAX_WIDTH = 1_099;

interface SidebarLayoutInput {
  userCollapsed: boolean;
  rightPaneOpen: boolean;
  viewportWidth: number | null;
  forceRail?: boolean;
}

export function shouldUseSidebarRail({
  userCollapsed,
  rightPaneOpen,
  viewportWidth,
  forceRail = false,
}: SidebarLayoutInput): boolean {
  if (viewportWidth === null || viewportWidth < DESKTOP_MIN_WIDTH) return false;
  return (
    userCollapsed ||
    forceRail ||
    (rightPaneOpen && viewportWidth <= TABLET_RAIL_MAX_WIDTH)
  );
}

export function isTemporarySidebarRail({
  rightPaneOpen,
  viewportWidth,
  forceRail = false,
}: SidebarLayoutInput): boolean {
  return (
    viewportWidth !== null &&
    viewportWidth >= DESKTOP_MIN_WIDTH &&
    (forceRail ||
      (rightPaneOpen && viewportWidth <= TABLET_RAIL_MAX_WIDTH))
  );
}
