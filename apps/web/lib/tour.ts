/**
 * First-run welcome tour (#136). The tour is the product walking a
 * cold-start user through the capability story — Rob-not-in-the-room for
 * friends-lane testers and pilot users who form their opinion in the first
 * five minutes.
 *
 * Steps anchor to `data-tour="<anchor>"` attributes on real surfaces. A
 * step whose anchor isn't currently visible (e.g. the sidebar drawer on
 * mobile) renders as a centered card instead — the tour never breaks.
 */
export interface TourStep {
  id: string;
  /** data-tour attribute value to spotlight; null = centered card. */
  anchor: string | null;
  title: string;
  body: string;
}

export type WelcomeStep = "name" | "tour";

export function resolveWelcomeStep(input: {
  startAtTour: boolean;
  savedStep: string | null;
  hasAssistantName: boolean;
}): WelcomeStep {
  if (
    input.startAtTour ||
    input.hasAssistantName ||
    input.savedStep === "tour"
  ) {
    return "tour";
  }
  return "name";
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "chat",
    anchor: "chat-input",
    title: "Start in chat",
    body: "Ask a question, draft something, or attach a common work file for analysis. Start with the work in front of you.",
  },
  {
    id: "artifacts",
    anchor: "nav-workspace",
    title: "Find created files in Artifacts",
    body: "Files Comparative creates are saved here. Open, preview, and download them without hunting through old chats.",
  },
  {
    id: "skills",
    anchor: "nav-skills",
    title: "Reuse good work with Skills",
    body: "Save a useful workflow as a Skill when you want to run the same process again.",
  },
  {
    id: "apps",
    anchor: "nav-apps",
    title: "Build small apps from chat",
    body: "Build and preview a small app in a conversation. Apps you publish are collected here.",
  },
  {
    id: "feedback",
    anchor: "nav-feedback",
    title: "Tell us what broke or felt confusing",
    body: "Report a bug or confusing moment here. Add a screenshot when it helps explain what happened.",
  },
];

export interface TourUser {
  tourCompletedAt: string | null;
}

/** Show the tour once: signed-in user who has never completed/skipped it. */
export function shouldShowTour(
  user: TourUser | null | undefined,
): boolean {
  if (!user) return false;
  return user.tourCompletedAt === null;
}
