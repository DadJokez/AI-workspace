export const SIDEBAR_COLLAPSED_STORAGE_KEY =
  "comparative.sidebar.collapsed";

const DESKTOP_MIN_WIDTH = 768;
const TABLET_RAIL_MAX_WIDTH = 1_099;

export function shouldUseSidebarRail({
  userCollapsed,
  rightPaneOpen,
  viewportWidth,
}: {
  userCollapsed: boolean;
  rightPaneOpen: boolean;
  viewportWidth: number | null;
}): boolean {
  if (viewportWidth === null || viewportWidth < DESKTOP_MIN_WIDTH) return false;
  return (
    userCollapsed ||
    (rightPaneOpen && viewportWidth <= TABLET_RAIL_MAX_WIDTH)
  );
}

export function isTemporaryTabletRail({
  userCollapsed,
  rightPaneOpen,
  viewportWidth,
}: {
  userCollapsed: boolean;
  rightPaneOpen: boolean;
  viewportWidth: number | null;
}): boolean {
  return (
    !userCollapsed &&
    rightPaneOpen &&
    viewportWidth !== null &&
    viewportWidth >= DESKTOP_MIN_WIDTH &&
    viewportWidth <= TABLET_RAIL_MAX_WIDTH
  );
}
