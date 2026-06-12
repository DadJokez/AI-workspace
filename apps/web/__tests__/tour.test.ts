import { describe, expect, it } from "vitest";
import { TOUR_STEPS, shouldShowTour } from "@/lib/tour";

/** #136 — first-run welcome tour gating and step integrity. */
describe("shouldShowTour", () => {
  it("shows the tour exactly for signed-in users who never completed it", () => {
    expect(shouldShowTour({ tourCompletedAt: null })).toBe(true);
    expect(
      shouldShowTour({ tourCompletedAt: "2026-06-12T00:00:00.000Z" }),
    ).toBe(false);
    expect(shouldShowTour(undefined)).toBe(false);
    expect(shouldShowTour(null)).toBe(false);
  });
});

describe("TOUR_STEPS", () => {
  it("starts with a centered welcome card", () => {
    expect(TOUR_STEPS[0]).toMatchObject({ id: "welcome", anchor: null });
  });

  it("keeps the tour short and ids/anchors unique", () => {
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(5);
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const anchors = TOUR_STEPS.map((s) => s.anchor).filter(Boolean);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("anchors only to surfaces that exist in the shell", () => {
    // data-tour attributes wired in ChatClient (chat-input) and Sidebar
    // (nav-<id>). If a step anchor changes, update the attribute too.
    const known = new Set([
      "chat-input",
      "nav-skills",
      "nav-apps",
      "nav-tools",
      "nav-vault",
      "nav-workspace",
    ]);
    for (const step of TOUR_STEPS) {
      if (step.anchor) expect(known.has(step.anchor)).toBe(true);
    }
  });
});
