import { describe, expect, it } from "vitest";
import {
  TOUR_STEPS,
  resolveWelcomeStep,
  shouldShowTour,
} from "@/lib/tour";

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
  it("walks only through the live capability surfaces", () => {
    expect(TOUR_STEPS.map(({ id, anchor }) => ({ id, anchor }))).toEqual([
      { id: "chat", anchor: "chat-input" },
      { id: "artifacts", anchor: "nav-workspace" },
      { id: "skills", anchor: "nav-skills" },
      { id: "apps", anchor: "nav-apps" },
      { id: "feedback", anchor: "nav-feedback" },
    ]);
  });

  it("keeps the tour short and ids/anchors unique", () => {
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(5);
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const anchors = TOUR_STEPS.map((s) => s.anchor).filter(Boolean);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("keeps setup and aspirational claims out of the tour", () => {
    const copy = TOUR_STEPS.map((step) => `${step.title} ${step.body}`).join(
      " ",
    );
    expect(TOUR_STEPS.some((step) => step.anchor === "nav-tools")).toBe(false);
    expect(copy).not.toMatch(/connect|coming soon|schedule|recommend|one click/i);
    expect(copy).not.toMatch(/reversible|pipeline|role|questionnaire/i);
    for (const step of TOUR_STEPS) {
      expect(step.body.split(/\s+/).length).toBeLessThanOrEqual(24);
    }
  });

  it("explains the alpha feedback loop", () => {
    const feedback = TOUR_STEPS.find((step) => step.id === "feedback");
    expect(feedback).toMatchObject({
      anchor: "nav-feedback",
      title: expect.stringContaining("broke"),
    });
    expect(feedback?.body).toContain("screenshot");
  });

  it("anchors only to surfaces that exist in the shell", () => {
    // data-tour attributes wired in ChatClient (chat-input) and Sidebar
    // (nav-<id>). If a step anchor changes, update the attribute too.
    const known = new Set([
      "chat-input",
      "nav-skills",
      "nav-apps",
      "nav-workspace",
      "nav-feedback",
    ]);
    for (const step of TOUR_STEPS) {
      if (step.anchor) expect(known.has(step.anchor)).toBe(true);
    }
  });
});

describe("resolveWelcomeStep", () => {
  it("starts a new user with assistant naming", () => {
    expect(
      resolveWelcomeStep({
        startAtTour: false,
        savedStep: null,
        hasAssistantName: false,
      }),
    ).toBe("name");
  });

  it("continues named and returning users directly into the tour", () => {
    expect(
      resolveWelcomeStep({
        startAtTour: false,
        savedStep: "tools",
        hasAssistantName: true,
      }),
    ).toBe("tour");
    expect(
      resolveWelcomeStep({
        startAtTour: true,
        savedStep: null,
        hasAssistantName: false,
      }),
    ).toBe("tour");
  });

  it("resumes the capability tour after a reload", () => {
    expect(
      resolveWelcomeStep({
        startAtTour: false,
        savedStep: "tour",
        hasAssistantName: false,
      }),
    ).toBe("tour");
  });
});
