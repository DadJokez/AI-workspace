import { describe, expect, it } from "vitest";
import {
  isTemporarySidebarRail,
  shouldUseSidebarRail,
} from "@/lib/sidebar-layout";

describe("sidebar layout", () => {
  it("uses the saved rail preference on desktop but not mobile", () => {
    expect(
      shouldUseSidebarRail({
        userCollapsed: true,
        rightPaneOpen: false,
        viewportWidth: 1_440,
      }),
    ).toBe(true);
    expect(
      shouldUseSidebarRail({
        userCollapsed: true,
        rightPaneOpen: false,
        viewportWidth: 767,
      }),
    ).toBe(false);
  });

  it("temporarily uses the rail for a tablet-width right pane", () => {
    const input = {
      userCollapsed: false,
      rightPaneOpen: true,
      viewportWidth: 1_000,
    };
    expect(shouldUseSidebarRail(input)).toBe(true);
    expect(isTemporarySidebarRail(input)).toBe(true);
    expect(
      isTemporarySidebarRail({ ...input, userCollapsed: true }),
    ).toBe(true);
    expect(
      shouldUseSidebarRail({ ...input, rightPaneOpen: false }),
    ).toBe(false);
    expect(
      shouldUseSidebarRail({ ...input, viewportWidth: 1_100 }),
    ).toBe(false);
  });

  it("temporarily uses the rail for a forced dense pane at wide widths", () => {
    const input = {
      userCollapsed: false,
      rightPaneOpen: true,
      viewportWidth: 1_440,
      forceRail: true,
    };

    expect(shouldUseSidebarRail(input)).toBe(true);
    expect(isTemporarySidebarRail(input)).toBe(true);
    expect(
      shouldUseSidebarRail({ ...input, forceRail: false }),
    ).toBe(false);
    expect(
      shouldUseSidebarRail({ ...input, viewportWidth: 767 }),
    ).toBe(false);
  });
});
