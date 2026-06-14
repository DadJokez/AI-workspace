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

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "welcome",
    anchor: null,
    title: "Welcome to Comparative",
    body: "One place to chat with AI that can actually act on your work — and to turn the useful things it does into skills, schedules, and apps you can share. Here's the two-minute lay of the land.",
  },
  {
    id: "chat",
    anchor: "chat-input",
    title: "Ask anything — bring your files",
    body: "Drop in PDFs, docs, spreadsheets, decks, screenshots, notes, HTML, or data files. Comparative extracts what it can, keeps the upload in Artifacts, and shows quiet work receipts while it reasons.",
  },
  {
    id: "skills",
    anchor: "nav-skills",
    title: "Skills: save it, run it again",
    body: "A skill is a saved agent you can run any time, put on a schedule (\"every Monday 8am\"), clone from a starter, and share with a teammate. Comparative will recommend skills when a workflow starts repeating.",
  },
  {
    id: "apps",
    anchor: "nav-apps",
    title: "Apps: from conversation to deployed tool",
    body: "Ask for a small dashboard or page in chat, then deploy the result behind workspace sign-in with one click. Artifact versions are grouped, reversible, and downloadable — no repos, no pipelines.",
  },
  {
    id: "trust",
    anchor: "nav-tools",
    title: "You're in control",
    body: "Tools shows exactly what's connected and what the agent may touch — you approve every provider. Recommendations are explicit, dismissible, and everything the agent does lands in an audit trail.",
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
