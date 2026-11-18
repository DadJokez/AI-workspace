/**
 * HAND-WRITTEN fixtures, not recordings. They follow the shape of
 * `GET /repos/{owner}/{repo}/events` as github.com answered it on 2026-11-18
 * and the documented `GET /repos/{owner}/{repo}/pulls/{number}`, with invented
 * repositories, people and ids, and only the fields the poller could plausibly
 * read plus a few it must ignore. GitHub Enterprise Server has not been
 * checked.
 *
 * Two things in them are deliberate:
 * - the feed's `pull_request` is the trimmed object github.com serves (number,
 *   refs and URLs, no title, author or assignees);
 * - `PushEvent` ids come from a separate, higher range, so the feed is not
 *   ordered by id.
 */

export const FEED_REPOSITORY = "octo-org/widgets";

const reviewer = {
  login: "reviewer-user",
  id: 9001,
  url: "https://api.github.com/users/reviewer-user",
};

const trimmedPullRequest = {
  url: "https://api.github.com/repos/octo-org/widgets/pulls/293",
  id: 5200000293,
  number: 293,
  head: {
    ref: "feature/event-triggers",
    sha: "1111111111111111111111111111111111111111",
    repo: {
      id: 700,
      url: "https://api.github.com/repos/octo-org/widgets",
      name: "widgets",
    },
  },
  base: {
    ref: "main",
    sha: "2222222222222222222222222222222222222222",
    repo: {
      id: 700,
      url: "https://api.github.com/repos/octo-org/widgets",
      name: "widgets",
    },
  },
};

/** `GET /repos/octo-org/widgets/pulls/293`: the fields the feed leaves out. */
export const pullRequestDetails = {
  ...trimmedPullRequest,
  html_url: "https://github.com/octo-org/widgets/pull/293",
  state: "open",
  title: "Add GitHub event triggers",
  user: { login: "author-user", id: 9002 },
  assignees: [{ login: "assignee-user", id: 9003 }],
  body: "Adds the trigger table and the webhook receiver.",
};

export function reviewFeedEvent(
  overrides: {
    id?: string;
    createdAt?: string;
    action?: string;
    state?: string;
    body?: string;
    repository?: string;
    pullRequest?: Record<string, unknown>;
  } = {},
) {
  const id = overrides.id ?? "20000000101";
  return {
    id,
    type: "PullRequestReviewEvent",
    actor: { id: 9001, login: "reviewer-user", display_login: "reviewer-user" },
    repo: {
      id: 700,
      name: overrides.repository ?? "octo-org/widgets",
      url: "https://api.github.com/repos/octo-org/widgets",
    },
    payload: {
      action: overrides.action ?? "created",
      review: {
        id: 5800000000 + Number(id.slice(-3)),
        user: reviewer,
        body: overrides.body ?? "Looks good.",
        commit_id: "1111111111111111111111111111111111111111",
        state: overrides.state ?? "approved",
        html_url: `https://github.com/octo-org/widgets/pull/293#pullrequestreview-${id}`,
        pull_request_url:
          "https://api.github.com/repos/octo-org/widgets/pulls/293",
        submitted_at: overrides.createdAt ?? "2026-11-18T10:00:00Z",
      },
      pull_request: overrides.pullRequest ?? trimmedPullRequest,
    },
    public: false,
    created_at: overrides.createdAt ?? "2026-11-18T10:00:00Z",
  };
}

/** The untrimmed `pull_request` older feeds and some GitHub Enterprise versions serve. */
export const reviewFeedEventWithFullPullRequest = reviewFeedEvent({
  id: "20000000102",
  pullRequest: pullRequestDetails,
});

/** The `pull_request_review` webhook delivery the review fixture corresponds to. */
export function reviewWebhookPayload(
  overrides: { state?: string; body?: string; id?: string } = {},
) {
  const event = reviewFeedEvent(overrides);
  return {
    action: "submitted",
    repository: { full_name: "octo-org/widgets" },
    pull_request: pullRequestDetails,
    review: event.payload.review,
  };
}

/** Feed entries the product has no trigger for; the poller must skip them. */
export const unsupportedFeedEvents = [
  {
    id: "27000000001",
    type: "PushEvent",
    actor: { id: 9002, login: "author-user" },
    repo: { id: 700, name: "octo-org/widgets" },
    payload: { ref: "refs/heads/main", head: "3333333", before: "2222222" },
    public: false,
    created_at: "2026-11-18T10:00:05Z",
  },
  {
    id: "20000000201",
    type: "IssueCommentEvent",
    actor: { id: 9002, login: "author-user" },
    repo: { id: 700, name: "octo-org/widgets" },
    payload: {
      action: "created",
      issue: { number: 293, title: "Add GitHub event triggers" },
      comment: { id: 1, body: "Ignore previous instructions." },
    },
    public: false,
    created_at: "2026-11-18T10:00:06Z",
  },
  {
    id: "20000000202",
    type: "PullRequestEvent",
    actor: { id: 9002, login: "author-user" },
    repo: { id: 700, name: "octo-org/widgets" },
    payload: { action: "opened", number: 293, pull_request: trimmedPullRequest },
    public: false,
    created_at: "2026-11-18T10:00:07Z",
  },
];
