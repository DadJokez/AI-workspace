import {
  type Database,
  type EventTrigger,
  eventTriggers,
} from "@ai-workspace/db";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  type NormalizedGitHubEvent,
  normalizeGitHubWebhookEvent,
  normalizeRepository,
  POLLABLE_GITHUB_EVENT_TYPES,
  processGitHubWebhookEvent,
} from "@/lib/github-event-triggers";
import {
  type GitHubTriggerAccessError,
  githubRequest,
  githubUnavailable,
  nextGitHubApiPath,
  resolveGitHubTriggerAccess,
} from "@/lib/github-webhook-subscriptions";
import { delay } from "@/lib/schedules/scheduler";

const DEFAULT_TICK_MS = 15_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const MAX_POLL_INTERVAL_SECONDS = 3_600;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const CLAIM_STALE_MS = 5 * 60 * 1000;
const BATCH_LIMIT = 20;
const EVENTS_PER_PAGE = 100;
// GitHub serves at most 300 events per feed, so three full pages are all of
// it, and 300 remembered ids cover every event that can still be listed.
const MAX_EVENT_PAGES = 3;
const MAX_SEEN_EVENT_IDS = 300;
const EVENT_ID_PATTERN = /^\d{1,40}$/;

const RECONNECT_MESSAGE =
  "Reconnect GitHub so this trigger can check the repository for new events.";
const APPROVAL_MESSAGE =
  "Approve GitHub administrative access so this trigger can check the repository for new events.";
const REPOSITORY_ACCESS_MESSAGE =
  "Comparative cannot read this repository's events with your GitHub access. Check the repository name and your access.";
const UNREACHABLE_MESSAGE =
  "GitHub could not be reached. Comparative will keep trying.";
const INCOMPLETE_MESSAGE =
  "Some GitHub events could not be processed yet. Comparative will retry.";

/**
 * Feed cursor kept per trigger in `event_triggers.poll_state`.
 *
 * The feed is neither ordered by event id nor strictly by time (git ref
 * events draw their ids from a separate, higher range and are interleaved),
 * so there is no "newer than the last id" test. A trigger instead remembers
 * the ids it has already been offered.
 */
export interface GitHubEventPollState {
  etag: string | null;
  /**
   * First-poll floor (ISO time): events GitHub stamped at or before it never
   * fire. Set once, when the poller first sees the trigger.
   */
  since: string;
  /** Newest event time on the feed at the last poll; paging stops there. */
  lastEventAt: string | null;
  seenEventIds: string[];
  /** Consecutive failed polls, for backoff. */
  failures: number;
  /** The message the poller last wrote to `last_error`, so it clears only its own. */
  error: string | null;
}

/** One supported entry of the feed, before it is given webhook shape. */
export interface GitHubFeedEvent {
  id: string;
  createdAt: number;
  repository: string;
  review: Record<string, unknown>;
  pullRequest: Record<string, unknown> & { number: number };
}

type EventsFetch =
  | { kind: "ok"; etag: string | null; intervalMs: number; events: unknown[] }
  | { kind: "not_modified"; intervalMs: number }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "failed"; message: string };

type PullRequestFetch =
  | { kind: "ok"; pullRequest: Record<string, unknown> }
  | { kind: "gone" }
  | { kind: "retry" };

/**
 * Reads one entry of `GET /repos/{owner}/{repo}/events`. Only
 * `PullRequestReviewEvent` with action `created` is supported: it is the feed's
 * name for the `pull_request_review` webhook with action `submitted`. Every
 * other entry, and anything malformed, is null.
 */
export function readGitHubFeedEvent(raw: unknown): GitHubFeedEvent | null {
  if (!isRecord(raw) || raw.type !== "PullRequestReviewEvent") return null;
  const id = typeof raw.id === "number" ? String(raw.id) : raw.id;
  const createdAt =
    typeof raw.created_at === "string" ? Date.parse(raw.created_at) : NaN;
  const repository = normalizeRepository(
    isRecord(raw.repo) ? raw.repo.name : null,
  );
  const payload = raw.payload;
  if (
    typeof id !== "string" ||
    !EVENT_ID_PATTERN.test(id) ||
    !Number.isFinite(createdAt) ||
    !repository ||
    !isRecord(payload) ||
    payload.action !== "created"
  ) {
    return null;
  }
  const { review, pull_request: pullRequest } = payload;
  if (
    !isRecord(review) ||
    !isRecord(pullRequest) ||
    typeof pullRequest.number !== "number" ||
    !Number.isSafeInteger(pullRequest.number)
  ) {
    return null;
  }
  return {
    id,
    createdAt,
    repository,
    review,
    pullRequest: { ...pullRequest, number: pullRequest.number },
  };
}

/** True when the feed entry's pull request lacks the fields a trigger filters on. */
export function feedEventNeedsPullRequest(event: GitHubFeedEvent): boolean {
  return typeof event.pullRequest.title !== "string";
}

/**
 * Gives a feed entry the body of the matching webhook delivery and runs it
 * through the webhook normalizer, so both ingest modes produce one shape and
 * one set of bounds on third-party text.
 *
 * github.com trims the feed's `pull_request` to its number, refs and URLs, so
 * the title, author and assignees come from `pullRequest` (the pull request
 * read with the same token). They describe the pull request at poll time, not
 * at review time. Null when the details are missing or are for another pull
 * request.
 */
export function normalizeGitHubFeedEvent(
  event: GitHubFeedEvent,
  pullRequest: Record<string, unknown> | null,
): NormalizedGitHubEvent | null {
  const details = feedEventNeedsPullRequest(event)
    ? pullRequest
    : event.pullRequest;
  if (!details || details.number !== event.pullRequest.number) return null;
  return normalizeGitHubWebhookEvent("pull_request_review", {
    action: "submitted",
    repository: { full_name: event.repository },
    pull_request: details,
    review: event.review,
  });
}

/**
 * Which feed entries a trigger has not been offered yet, oldest first.
 *
 * First-poll rule: a trigger never fires for an event GitHub stamped at or
 * before `since`, the moment the poller first saw the trigger (after it was
 * created, resumed, or the deployment switched to poll mode). The feed holds
 * up to 90 days of history and none of it is replayed.
 */
export function selectUnseenFeedEvents(
  state: Pick<GitHubEventPollState, "since" | "seenEventIds">,
  events: readonly GitHubFeedEvent[],
): GitHubFeedEvent[] {
  const since = Date.parse(state.since);
  const seen = new Set(state.seenEventIds);
  return events
    .filter((event) => event.createdAt > since && !seen.has(event.id))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Wait after `failures` consecutive failed polls: doubling, capped at an hour. */
export function pollBackoffMs(failures: number): number {
  return Math.min(
    MAX_BACKOFF_MS,
    DEFAULT_POLL_INTERVAL_SECONDS * 1000 * 2 ** Math.min(failures, 10),
  );
}

/**
 * How long GitHub asked us to stay away, or null when the response is not a
 * rate limit. Primary limits answer 403 or 429 with no requests remaining;
 * secondary limits send `Retry-After`.
 */
export function rateLimitDelayMs(response: Response, now: Date): number | null {
  const retryAfter = Number.parseInt(
    response.headers.get("retry-after") ?? "",
    10,
  );
  const limited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        Number.isFinite(retryAfter)));
  if (!limited) return null;
  const reset = Number.parseInt(
    response.headers.get("x-ratelimit-reset") ?? "",
    10,
  );
  const waits = [
    Number.isFinite(retryAfter) ? retryAfter * 1000 : 0,
    response.headers.get("x-ratelimit-remaining") === "0" &&
    Number.isFinite(reset)
      ? reset * 1000 - now.getTime()
      : 0,
    DEFAULT_POLL_INTERVAL_SECONDS * 1000,
  ];
  return Math.min(MAX_BACKOFF_MS, Math.max(...waits));
}

/**
 * Poll mode's check when a trigger is created: the owner's token must be able
 * to read the repository's events feed, or the trigger would never fire.
 */
export async function verifyGitHubRepositoryEventAccess({
  db,
  userId,
  repository,
  fetchImpl = fetch,
}: {
  db: Database;
  userId: string;
  repository: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true } | GitHubTriggerAccessError> {
  const access = await resolveGitHubTriggerAccess({ db, userId });
  if (!access.ok) return access;
  let response: Response;
  try {
    response = await githubRequest(
      fetchImpl,
      access.accessToken,
      `${eventsPath(repository)}?per_page=1`,
    );
  } catch {
    return githubUnavailable();
  }
  if (response.ok) return { ok: true };
  if (response.status === 401) {
    return {
      ok: false,
      status: 409,
      error: "github_reconnect_required",
      message: "Reconnect GitHub before adding this trigger.",
    };
  }
  if (
    (response.status === 403 || response.status === 404) &&
    rateLimitDelayMs(response, new Date()) === null
  ) {
    return {
      ok: false,
      status: 403,
      error: "github_repository_access_required",
      message: REPOSITORY_ACCESS_MESSAGE,
    };
  }
  return githubUnavailable();
}

/**
 * One poller pass (WP-06). Each distinct (trigger owner, repository) with an
 * enabled pollable trigger is one poll: its feed is read with that owner's
 * token and its events are offered to that owner's triggers only. Polls are
 * leased with the scheduler's conditional-update claim, so concurrent workers
 * do not read the same owner's repository twice.
 */
export async function processDueGitHubEventPolls({
  db,
  workerId,
  now = new Date(),
  fetchImpl = fetch,
}: {
  db: Database;
  workerId: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<{ polled: number; failed: number }> {
  const pollable = and(
    eq(eventTriggers.source, "github"),
    eq(eventTriggers.enabled, true),
    isNull(eventTriggers.deletedAt),
    inArray(eventTriggers.eventType, [...POLLABLE_GITHUB_EVENT_TYPES]),
  );
  // The first-poll floor needs no request, so a new or resumed trigger gets
  // it on the next pass even while its repository is backing off.
  await db
    .update(eventTriggers)
    .set({ pollState: freshPollState(now) })
    .where(and(pollable, isNull(eventTriggers.pollState)));

  const staleCutoff = new Date(now.getTime() - CLAIM_STALE_MS);
  const unclaimed = or(
    isNull(eventTriggers.pollClaimedAt),
    lt(eventTriggers.pollClaimedAt, staleCutoff),
  );
  // A repository is due when none of its owner's triggers is still waiting,
  // and free when none is claimed: a trigger added mid-poll joins the next one.
  const due = await db
    .select({
      userId: eventTriggers.userId,
      repository: eventTriggers.repository,
    })
    .from(eventTriggers)
    .where(pollable)
    .groupBy(eventTriggers.userId, eventTriggers.repository)
    .having(
      sql`bool_and(${unclaimed}) and bool_and(${or(
        isNull(eventTriggers.pollNextAt),
        lte(eventTriggers.pollNextAt, now),
      )})`,
    )
    .orderBy(sql`min(${eventTriggers.pollNextAt}) asc nulls first`)
    .limit(BATCH_LIMIT);

  let polled = 0;
  let failed = 0;
  for (const group of due) {
    const claimed = await db
      .update(eventTriggers)
      .set({ pollClaimedAt: now, pollClaimedBy: workerId })
      .where(
        and(
          pollable,
          eq(eventTriggers.userId, group.userId),
          eq(eventTriggers.repository, group.repository),
          unclaimed,
        ),
      )
      .returning();
    if (claimed.length === 0) continue; // another worker won the claim

    let outcomes: PollOutcome[];
    try {
      outcomes = await pollRepository({
        db,
        userId: group.userId,
        repository: group.repository,
        triggers: claimed,
        now,
        fetchImpl,
      });
      polled += 1;
    } catch (err) {
      failed += 1;
      process.stderr.write(
        `[github-event-poll-error] ${JSON.stringify({
          workerId,
          repository: group.repository,
          message: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
      // Events may have been read but not handled: drop the ETag so the next
      // poll reads the feed again instead of answering "nothing new".
      outcomes = claimed.map((trigger) => {
        const outcome = failedOutcome(trigger, INCOMPLETE_MESSAGE, now);
        return { ...outcome, state: { ...outcome.state, etag: null } };
      });
    }
    for (const outcome of outcomes) {
      await releaseTrigger({ db, workerId, outcome });
    }
  }
  return { polled, failed };
}

interface PollOutcome {
  trigger: EventTrigger;
  state: GitHubEventPollState;
  nextAt: Date;
}

async function pollRepository({
  db,
  userId,
  repository,
  triggers,
  now,
  fetchImpl,
}: {
  db: Database;
  userId: string;
  repository: string;
  triggers: EventTrigger[];
  now: Date;
  fetchImpl: typeof fetch;
}): Promise<PollOutcome[]> {
  const fail = (message: string) =>
    triggers.map((trigger) => failedOutcome(trigger, message, now));

  const access = await resolveGitHubTriggerAccess({ db, userId });
  if (!access.ok) {
    return fail(
      access.error === "github_admin_approval_required"
        ? APPROVAL_MESSAGE
        : RECONNECT_MESSAGE,
    );
  }

  const states = triggers.map((trigger) => pollStateOf(trigger, now));
  // One request serves every trigger of the group, so it can be conditional
  // only when they all saw the same version of the feed.
  const etag = states.every((state) => state.etag === states[0]!.etag)
    ? states[0]!.etag
    : null;
  const pagingFloor = Math.min(
    ...states.map((state) => Date.parse(state.lastEventAt ?? state.since)),
  );
  const fetched = await fetchRepositoryEvents({
    fetchImpl,
    accessToken: access.accessToken,
    repository,
    etag,
    pagingFloor,
    now,
  });
  if (fetched.kind === "failed") return fail(fetched.message);
  if (fetched.kind === "rate_limited") {
    // Not the owner's problem and not a fault: wait out the limit as told.
    const nextAt = new Date(now.getTime() + fetched.retryAfterMs);
    return triggers.map((trigger, index) => ({
      trigger,
      state: states[index]!,
      nextAt,
    }));
  }
  const nextAt = new Date(now.getTime() + fetched.intervalMs);
  if (fetched.kind === "not_modified") {
    return triggers.map((trigger, index) => ({
      trigger,
      state: { ...states[index]!, failures: 0, error: null },
      nextAt,
    }));
  }

  // The feed is read with this owner's token for this repository; an entry
  // naming any other repository is dropped rather than trusted.
  const feedEvents = fetched.events
    .map(readGitHubFeedEvent)
    .filter(
      (event): event is GitHubFeedEvent =>
        event !== null && event.repository === repository,
    );
  const pending = new Map<
    string,
    { event: GitHubFeedEvent; triggerIds: string[] }
  >();
  triggers.forEach((trigger, index) => {
    for (const event of selectUnseenFeedEvents(states[index]!, feedEvents)) {
      const entry = pending.get(event.id) ?? { event, triggerIds: [] };
      entry.triggerIds.push(trigger.id);
      pending.set(event.id, entry);
    }
  });

  const handled = new Map<string, string[]>();
  const pullRequests = new Map<number, PullRequestFetch>();
  let complete = true;
  const ordered = [...pending.values()].sort(
    (a, b) => a.event.createdAt - b.event.createdAt,
  );
  for (const { event, triggerIds } of ordered) {
    let details: Record<string, unknown> | null = null;
    if (feedEventNeedsPullRequest(event)) {
      const number = event.pullRequest.number;
      const pullRequest =
        pullRequests.get(number) ??
        (await fetchPullRequest({
          fetchImpl,
          accessToken: access.accessToken,
          repository,
          number,
        }));
      pullRequests.set(number, pullRequest);
      if (pullRequest.kind === "retry") {
        complete = false;
        break;
      }
      details = pullRequest.kind === "ok" ? pullRequest.pullRequest : null;
    }
    const normalized = normalizeGitHubFeedEvent(event, details);
    if (normalized) {
      // Same pipeline, same prompt framing and same (trigger, delivery) key as
      // a webhook delivery; the event id stands in for the delivery id.
      await processGitHubWebhookEvent({
        db,
        deliveryId: event.id,
        event: normalized,
        scope: { userId, triggerIds },
        now,
      });
    }
    for (const triggerId of triggerIds) {
      handled.set(triggerId, [...(handled.get(triggerId) ?? []), event.id]);
    }
  }

  const newestEventAt = newestEventTime(fetched.events);
  return triggers.map((trigger, index) => {
    const state = states[index]!;
    const failures = complete ? 0 : state.failures + 1;
    return {
      trigger,
      state: {
        // Without the ETag the next poll re-reads the feed and picks up
        // whatever was left unhandled.
        etag: complete ? fetched.etag : null,
        since: state.since,
        lastEventAt:
          complete && newestEventAt !== null
            ? new Date(
                Math.max(
                  newestEventAt,
                  Date.parse(state.lastEventAt ?? state.since),
                ),
              ).toISOString()
            : state.lastEventAt,
        seenEventIds: [
          ...state.seenEventIds,
          ...(handled.get(trigger.id) ?? []),
        ].slice(-MAX_SEEN_EVENT_IDS),
        failures,
        error: complete ? null : INCOMPLETE_MESSAGE,
      },
      nextAt: complete
        ? nextAt
        : new Date(now.getTime() + pollBackoffMs(failures)),
    };
  });
}

async function fetchRepositoryEvents({
  fetchImpl,
  accessToken,
  repository,
  etag,
  pagingFloor,
  now,
}: {
  fetchImpl: typeof fetch;
  accessToken: string;
  repository: string;
  etag: string | null;
  pagingFloor: number;
  now: Date;
}): Promise<EventsFetch> {
  const events: unknown[] = [];
  let firstPage: Response | undefined;
  let nextPath: string | undefined =
    `${eventsPath(repository)}?per_page=${EVENTS_PER_PAGE}`;
  for (let page = 0; nextPath && page < MAX_EVENT_PAGES; page += 1) {
    let response: Response;
    try {
      response = await githubRequest(
        fetchImpl,
        accessToken,
        nextPath,
        "GET",
        undefined,
        page === 0 && etag ? { "If-None-Match": etag } : {},
      );
    } catch {
      return { kind: "failed", message: UNREACHABLE_MESSAGE };
    }
    if (page === 0 && response.status === 304) {
      return { kind: "not_modified", intervalMs: pollIntervalMs(response) };
    }
    if (!response.ok) {
      const retryAfterMs = rateLimitDelayMs(response, now);
      if (retryAfterMs !== null) return { kind: "rate_limited", retryAfterMs };
      if (response.status === 401) {
        return { kind: "failed", message: RECONNECT_MESSAGE };
      }
      if (response.status === 403 || response.status === 404) {
        return { kind: "failed", message: REPOSITORY_ACCESS_MESSAGE };
      }
      return { kind: "failed", message: UNREACHABLE_MESSAGE };
    }

    let pageEvents: unknown;
    try {
      pageEvents = await response.json();
    } catch {
      return { kind: "failed", message: UNREACHABLE_MESSAGE };
    }
    if (!Array.isArray(pageEvents)) {
      return { kind: "failed", message: UNREACHABLE_MESSAGE };
    }
    events.push(...pageEvents);
    firstPage ??= response;

    // Stop once a page reaches back to what the previous poll already saw.
    const oldest = Math.min(
      ...pageEvents.map((event) => eventTime(event) ?? Infinity),
    );
    if (oldest <= pagingFloor) break;
    const parsedNext = nextGitHubApiPath(response.headers.get("link"));
    if (parsedNext === null) {
      return { kind: "failed", message: UNREACHABLE_MESSAGE };
    }
    nextPath = parsedNext;
  }
  return {
    kind: "ok",
    etag: firstPage?.headers.get("etag") ?? null,
    intervalMs: firstPage ? pollIntervalMs(firstPage) : pollIntervalMs(null),
    events,
  };
}

async function fetchPullRequest({
  fetchImpl,
  accessToken,
  repository,
  number,
}: {
  fetchImpl: typeof fetch;
  accessToken: string;
  repository: string;
  number: number;
}): Promise<PullRequestFetch> {
  const [owner, repo] = repository.split("/");
  try {
    const response = await githubRequest(
      fetchImpl,
      accessToken,
      `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/pulls/${number}`,
    );
    // A deleted pull request can never be described; its event is dropped.
    if (response.status === 404 || response.status === 410) {
      return { kind: "gone" };
    }
    if (!response.ok) return { kind: "retry" };
    const pullRequest = (await response.json()) as unknown;
    return isRecord(pullRequest)
      ? { kind: "ok", pullRequest }
      : { kind: "retry" };
  } catch {
    return { kind: "retry" };
  }
}

async function releaseTrigger({
  db,
  workerId,
  outcome,
}: {
  db: Database;
  workerId: string;
  outcome: PollOutcome;
}): Promise<void> {
  const previousError = pollStateOf(outcome.trigger, outcome.nextAt).error;
  const { error } = outcome.state;
  await db
    .update(eventTriggers)
    .set({
      pollState: outcome.state,
      pollNextAt: outcome.nextAt,
      pollClaimedAt: null,
      pollClaimedBy: null,
      // The delivery pipeline also writes last_error; only a message this
      // poller wrote earlier is cleared when the poll recovers.
      lastError:
        error ??
        (previousError
          ? sql`nullif(${eventTriggers.lastError}, ${previousError})`
          : undefined),
    })
    .where(
      and(
        eq(eventTriggers.id, outcome.trigger.id),
        eq(eventTriggers.pollClaimedBy, workerId),
      ),
    );
}

function failedOutcome(
  trigger: EventTrigger,
  message: string,
  now: Date,
): PollOutcome {
  const state = pollStateOf(trigger, now);
  const failures = state.failures + 1;
  return {
    trigger,
    state: { ...state, failures, error: message },
    nextAt: new Date(now.getTime() + pollBackoffMs(failures)),
  };
}

function freshPollState(now: Date): GitHubEventPollState {
  return {
    etag: null,
    since: now.toISOString(),
    lastEventAt: null,
    seenEventIds: [],
    failures: 0,
    error: null,
  };
}

/** The stored cursor, or a fresh one when the column is empty or unreadable. */
function pollStateOf(
  trigger: Pick<EventTrigger, "pollState">,
  now: Date,
): GitHubEventPollState {
  const value = trigger.pollState;
  if (
    !isRecord(value) ||
    typeof value.since !== "string" ||
    !Number.isFinite(Date.parse(value.since))
  ) {
    return freshPollState(now);
  }
  return {
    etag: typeof value.etag === "string" ? value.etag : null,
    since: value.since,
    lastEventAt:
      typeof value.lastEventAt === "string" &&
      Number.isFinite(Date.parse(value.lastEventAt))
        ? value.lastEventAt
        : null,
    seenEventIds: Array.isArray(value.seenEventIds)
      ? value.seenEventIds.filter(
          (id): id is string => typeof id === "string",
        )
      : [],
    failures:
      typeof value.failures === "number" && value.failures > 0
        ? Math.floor(value.failures)
        : 0,
    error: typeof value.error === "string" ? value.error : null,
  };
}

function eventsPath(repository: string): string {
  const [owner, repo] = repository.split("/");
  return `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/events`;
}

/** `X-Poll-Interval` is GitHub's minimum number of seconds between polls. */
function pollIntervalMs(response: Response | null): number {
  const seconds = Number.parseInt(
    response?.headers.get("x-poll-interval") ?? "",
    10,
  );
  return (
    (Number.isFinite(seconds) && seconds > 0
      ? Math.min(seconds, MAX_POLL_INTERVAL_SECONDS)
      : DEFAULT_POLL_INTERVAL_SECONDS) * 1000
  );
}

function eventTime(event: unknown): number | null {
  const time =
    isRecord(event) && typeof event.created_at === "string"
      ? Date.parse(event.created_at)
      : NaN;
  return Number.isFinite(time) ? time : null;
}

function newestEventTime(events: readonly unknown[]): number | null {
  const times = events
    .map(eventTime)
    .filter((time): time is number => time !== null);
  return times.length > 0 ? Math.max(...times) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Long-running poller loop hosted in the chat-run worker process beside the
 * scheduler. The tick only finds repositories that are due; how often each one
 * is read is GitHub's `X-Poll-Interval`.
 */
export async function runGitHubEventPollerLoop({
  db,
  workerId,
  tickMs = DEFAULT_TICK_MS,
  signal,
}: {
  db: Database;
  workerId: string;
  tickMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  while (!signal?.aborted) {
    try {
      await processDueGitHubEventPolls({ db, workerId });
    } catch (err) {
      process.stderr.write(
        `[github-event-poll-pass-error] ${JSON.stringify({
          workerId,
          message: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    }
    await delay(tickMs, signal);
  }
}
