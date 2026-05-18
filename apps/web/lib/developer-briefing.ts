export const DEVELOPER_BRIEFING_RECIPE_SLUG = "developer-briefing";

const STALE_DAYS = 7;

export function buildDeveloperBriefingPrompt(now = new Date()): string {
  const today = toDateString(now);
  const staleBefore = toDateString(
    new Date(now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1_000),
  );

  return [
    "Run the Developer Briefing workflow for the current user.",
    "",
    `Today is ${today}. Treat open pull requests with no update since ${staleBefore} as stale.`,
    "",
    "Use only connected GitHub MCP read tools. Start by identifying the current GitHub user if a viewer/current-user tool is available.",
    "",
    "Aggregation plan:",
    "1. Find open pull requests authored by the current user that need attention.",
    "2. Find open pull requests requesting review from the current user.",
    "3. Find open pull requests involving the current user that are stale.",
    "4. For each important pull request, inspect checks/status when available and classify CI as failing, pending, passing, or unknown.",
    "",
    "Useful GitHub search shapes, when supported by the available tools:",
    "- is:pr is:open author:@me archived:false",
    "- is:pr is:open review-requested:@me archived:false",
    `- is:pr is:open involves:@me updated:<${staleBefore} archived:false`,
    "",
    "If @me/current-user filters are not supported, use the closest available read-only GitHub tools and say what could not be verified. Never invent PRs, statuses, reviewers, or checks.",
    "",
    "For each PR you include, capture: repository, PR number, title, URL, author, review state if available, last updated date, CI/check summary, why it matters, and the recommended next action.",
    "",
    "Return concise Markdown with exactly these sections:",
    "## Summary",
    "- One line with counts for authored, review-requested, stale, failing CI, and unknown CI.",
    "",
    "## Needs my attention",
    "- Bullets for authored PRs or direct blockers. Include links.",
    "",
    "## Waiting on my review",
    "- Bullets for PRs requesting my review. Include links.",
    "",
    "## Stale or drifting",
    "- Bullets for stale PRs or branches. Include last updated date.",
    "",
    "## Failing or unknown CI",
    "- Bullets grouped by failing, pending, and unknown. Name failing checks when available.",
    "",
    "## Suggested next actions",
    "- 3 to 5 ordered actions, highest leverage first.",
  ].join("\n");
}

function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}
