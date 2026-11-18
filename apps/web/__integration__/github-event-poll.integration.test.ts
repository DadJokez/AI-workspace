import { createHmac, randomBytes } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq } from "drizzle-orm";
import { DEFAULT_MODEL_ID } from "@ai-workspace/agent";
import type { SessionUser } from "@ai-workspace/auth";
import {
  createDb,
  eventTriggerDeliveries,
  eventTriggers,
  oauthTokens,
  runs,
  skills,
  userToolAttestations,
  users,
} from "@ai-workspace/db";
import {
  type GitHubEventPollState,
  processDueGitHubEventPolls,
} from "@/lib/github-event-poller";
import {
  normalizeGitHubWebhookEvent,
  processGitHubWebhookEvent,
} from "@/lib/github-event-triggers";
import { encryptSecret } from "@/lib/oauth/crypto";
import {
  FEED_REPOSITORY,
  pullRequestDetails,
  reviewFeedEvent,
  reviewWebhookPayload,
  unsupportedFeedEvents,
} from "../__tests__/fixtures/github-feed-events";

/**
 * WP-06: GitHub event triggers in poll mode, against real Postgres and a
 * stubbed GitHub API. The stub answers by bearer token, so every assertion
 * about whose token read what is an assertion about real requests. Covered:
 * the first-poll rule, dedupe across polls, the ETag 304 path, the lease,
 * rate-limit and failure backoff, per-owner scoping, and the acceptance case —
 * one review firing the same run through the webhook route and through the
 * poller.
 */

const DB_URL = process.env.DATABASE_URL;

// #479 retro-review: never green-by-skip in CI (see scoping suite).
if (!DB_URL && process.env.CI) {
  throw new Error(
    "GitHub event poll integration suite: DATABASE_URL is empty in CI — the " +
      "INTEGRATION_DATABASE_URL plumbing is broken; refusing to green-by-skip.",
  );
}

// Enqueue only: this lane has no runtime, so fired runs stay queued.
process.env.CHAT_RUN_IN_PROCESS_WORKER = "0";
process.env.OAUTH_ENCRYPTION_KEY ??= randomBytes(32).toString("hex");

const WEBHOOK_SECRET = "it-github-webhook-secret";
const ALICE_TOKEN = "it-alice-github-token";
const BOB_TOKEN = "it-bob-github-token";
const T0 = new Date("2026-11-18T10:00:00.000Z");
const after = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let currentUser: SessionUser | null = null;
vi.mock("@/lib/auth/getSessionUser", () => ({
  getSessionUser: async () => currentUser,
}));

interface StubFeed {
  etag?: string;
  events?: unknown[];
  /** Answer the feed with this status instead of the events. */
  status?: number;
  headers?: Record<string, string>;
  pollInterval?: string;
  /** Later pages, served through `Link: rel="next"`. */
  pages?: unknown[][];
  pullRequestStatus?: number;
  /** Serve the events for this repository only; others have an empty feed. */
  onlyRepository?: string;
}

interface StubRequest {
  path: string;
  token: string;
  ifNoneMatch: string | null;
}

/** GitHub as seen by each bearer token: a token with no feed gets a 404. */
function stubGitHub(feeds: Record<string, StubFeed>) {
  const requests: StubRequest[] = [];
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const token = (headers.get("authorization") ?? "").replace("Bearer ", "");
    const ifNoneMatch = headers.get("if-none-match");
    requests.push({ path: `${url.pathname}${url.search}`, token, ifNoneMatch });

    const feed = feeds[token];
    if (!feed) return new Response("{}", { status: 404 });
    if (url.pathname.includes("/pulls/")) {
      return feed.pullRequestStatus
        ? new Response("{}", { status: feed.pullRequestStatus })
        : json(pullRequestDetails);
    }
    if (feed.status) {
      return new Response("{}", { status: feed.status, headers: feed.headers });
    }
    const pollInterval = { "x-poll-interval": feed.pollInterval ?? "60" };
    if (
      feed.onlyRepository &&
      !url.pathname.startsWith(`/repos/${feed.onlyRepository}/`)
    ) {
      return json([], pollInterval);
    }
    const page = Number(url.searchParams.get("page") ?? "1");
    if (page > 1) return json(feed.pages?.[page - 2] ?? []);
    if (feed.etag && ifNoneMatch === feed.etag) {
      return new Response(null, { status: 304, headers: pollInterval });
    }
    return json(feed.events ?? [], {
      ...pollInterval,
      ...(feed.etag ? { etag: feed.etag } : {}),
      ...(feed.pages?.length
        ? {
            link: `<${url.origin}${url.pathname}?per_page=100&page=2>; rel="next"`,
          }
        : {}),
    });
  }) as typeof fetch;
  return {
    fetchImpl,
    requests,
    feedRequests: () =>
      requests.filter((request) => request.path.includes("/events")),
  };
}

const suite = describe.skipIf(!DB_URL);

suite("GitHub event triggers in poll mode (real Postgres, stubbed GitHub)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 6 });

  let alice: SessionUser;
  let bob: SessionUser;
  let aliceSkillId: string;
  let bobSkillId: string;

  async function seedUser(name: string, token: string) {
    const [user] = await db
      .insert(users)
      .values({
        pingSubject: `it-event-poll-${name}`,
        email: `event-poll-${name}@example.com`,
        displayName: name,
        role: "user",
      })
      .returning();
    await db.insert(oauthTokens).values({
      userId: user!.id,
      provider: "github",
      accessToken: encryptSecret(token),
    });
    await db.insert(userToolAttestations).values({
      userId: user!.id,
      scopeType: "provider",
      provider: "github",
      action: "admin",
    });
    const [skill] = await db
      .insert(skills)
      .values({
        slug: `it-event-poll-${name}-${Date.now()}`,
        name: `${name} review digest`,
        ownerUserId: user!.id,
        systemPrompt: "Summarize the review.",
        modelId: DEFAULT_MODEL_ID,
        mcpProviders: [],
      })
      .returning();
    return {
      session: {
        id: user!.id,
        email: user!.email,
        displayName: user!.displayName,
        role: user!.role,
      } as SessionUser,
      skillId: skill!.id,
    };
  }

  async function addTrigger(
    owner: SessionUser,
    skillId: string,
    overrides: Partial<typeof eventTriggers.$inferInsert> = {},
  ) {
    const [trigger] = await db
      .insert(eventTriggers)
      .values({
        userId: owner.id,
        skillId,
        source: "github",
        repository: FEED_REPOSITORY,
        eventType: "pull_request_review",
        action: "submitted",
        filters: {},
        threadMode: "new",
        ...overrides,
      })
      .returning();
    return trigger!;
  }

  async function triggerRow(id: string) {
    const [row] = await db
      .select()
      .from(eventTriggers)
      .where(eq(eventTriggers.id, id));
    return {
      ...row!,
      state: row!.pollState as GitHubEventPollState | null,
    };
  }

  const runsOf = (triggerId: string) =>
    db.select().from(runs).where(eq(runs.eventTriggerId, triggerId));

  const poll = (
    github: ReturnType<typeof stubGitHub>,
    now: Date,
    workerId = "worker-1",
  ) =>
    processDueGitHubEventPolls({
      db,
      workerId,
      now,
      fetchImpl: github.fetchImpl,
    });

  beforeAll(async () => {
    await db.select({ id: users.id }).from(users).limit(1);
  });

  beforeEach(async () => {
    // users cascade wipes tokens, skills, triggers, deliveries and runs.
    await db.delete(users);
    const a = await seedUser("alice", ALICE_TOKEN);
    const b = await seedUser("bob", BOB_TOKEN);
    alice = a.session;
    aliceSkillId = a.skillId;
    bob = b.session;
    bobSkillId = b.skillId;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  afterAll(async () => {
    await db.delete(users);
  });

  it("first poll: sets the floor and replays none of the feed's history", async () => {
    const trigger = await addTrigger(alice, aliceSkillId);
    const feed: StubFeed = {
      etag: 'W/"v1"',
      events: [
        ...unsupportedFeedEvents,
        reviewFeedEvent({ id: "20000000050", createdAt: "2026-11-18T09:59:59Z" }),
        reviewFeedEvent({ id: "20000000040", createdAt: "2026-09-01T08:00:00Z" }),
      ],
    };
    const github = stubGitHub({ [ALICE_TOKEN]: feed });

    await poll(github, T0);

    expect(await runsOf(trigger.id)).toHaveLength(0);
    let row = await triggerRow(trigger.id);
    expect(row.state).toMatchObject({
      since: T0.toISOString(),
      etag: 'W/"v1"',
      seenEventIds: [],
      failures: 0,
    });
    expect(row.pollNextAt).toEqual(after(60));
    expect(row.pollClaimedBy).toBeNull();
    // Nothing was offered, so no pull request was read either.
    expect(github.requests.every((r) => r.path.includes("/events"))).toBe(true);

    // A review submitted after the floor is the first thing that fires.
    feed.etag = 'W/"v2"';
    feed.events = [
      reviewFeedEvent({ id: "20000000101", createdAt: "2026-11-18T10:00:30Z" }),
      ...feed.events!,
    ];
    await poll(github, after(61));

    const fired = await runsOf(trigger.id);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      userId: alice.id,
      triggerType: "github_event",
      eventDeliveryId: "20000000101",
      status: "queued",
    });
    row = await triggerRow(trigger.id);
    expect(row.state?.seenEventIds).toEqual(["20000000101"]);
    expect(row.lastFiredAt).not.toBeNull();
  });

  it("does not fire an event twice across polls, with or without the cursor", async () => {
    const trigger = await addTrigger(alice, aliceSkillId);
    const feed: StubFeed = { etag: 'W/"v1"', events: [] };
    const github = stubGitHub({ [ALICE_TOKEN]: feed });
    await poll(github, T0);

    feed.etag = 'W/"v2"';
    feed.events = [
      reviewFeedEvent({ id: "20000000101", createdAt: "2026-11-18T10:00:30Z" }),
    ];
    await poll(github, after(61));
    expect(await runsOf(trigger.id)).toHaveLength(1);

    // The same entry is listed again under a new ETag (another event type
    // arrived): the trigger remembers it.
    feed.etag = 'W/"v3"';
    feed.events = [...unsupportedFeedEvents, ...feed.events];
    await poll(github, after(122));
    expect(await runsOf(trigger.id)).toHaveLength(1);

    // Even with the cursor's memory lost, the unique (trigger, delivery) key
    // the webhook path relies on refuses the second run.
    const row = await triggerRow(trigger.id);
    await db
      .update(eventTriggers)
      .set({ pollState: { ...row.state!, etag: null, seenEventIds: [] } })
      .where(eq(eventTriggers.id, trigger.id));
    await poll(github, after(183));

    expect(await runsOf(trigger.id)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(eventTriggerDeliveries)
        .where(eq(eventTriggerDeliveries.triggerId, trigger.id)),
    ).toHaveLength(1);
  });

  it("sends If-None-Match, does nothing on 304, and respects X-Poll-Interval", async () => {
    const trigger = await addTrigger(alice, aliceSkillId);
    const feed: StubFeed = { etag: 'W/"v1"', events: [], pollInterval: "120" };
    const github = stubGitHub({ [ALICE_TOKEN]: feed });

    await poll(github, T0);
    expect(github.feedRequests()).toHaveLength(1);
    expect(github.feedRequests()[0]).toMatchObject({
      path: `/repos/octo-org/widgets/events?per_page=100`,
      token: ALICE_TOKEN,
      ifNoneMatch: null,
    });
    expect((await triggerRow(trigger.id)).pollNextAt).toEqual(after(120));

    // Not due yet: GitHub asked for 120 seconds between polls.
    await poll(github, after(119));
    expect(github.feedRequests()).toHaveLength(1);

    const before = await triggerRow(trigger.id);
    await poll(github, after(121));
    expect(github.feedRequests()).toHaveLength(2);
    expect(github.feedRequests()[1]!.ifNoneMatch).toBe('W/"v1"');
    const afterNotModified = await triggerRow(trigger.id);
    expect(afterNotModified.state).toEqual(before.state);
    expect(afterNotModified.pollNextAt).toEqual(after(241));
    expect(await runsOf(trigger.id)).toHaveLength(0);
  });

  it("leases a repository to one worker at a time", async () => {
    const trigger = await addTrigger(alice, aliceSkillId);
    const feed: StubFeed = { etag: 'W/"v1"', events: [] };
    const github = stubGitHub({ [ALICE_TOKEN]: feed });
    await poll(github, T0);

    feed.etag = 'W/"v2"';
    feed.events = [
      reviewFeedEvent({ id: "20000000101", createdAt: "2026-11-18T10:00:30Z" }),
    ];
    // Two workers race for the same due repository.
    await Promise.all([
      poll(github, after(61), "worker-1"),
      poll(github, after(61), "worker-2"),
    ]);
    expect(github.feedRequests()).toHaveLength(2); // the first poll, then one winner
    expect(await runsOf(trigger.id)).toHaveLength(1);

    // A live claim held by another worker keeps everyone else out.
    await db
      .update(eventTriggers)
      .set({ pollClaimedAt: after(200), pollClaimedBy: "worker-9" })
      .where(eq(eventTriggers.id, trigger.id));
    await poll(github, after(300), "worker-1");
    expect(github.feedRequests()).toHaveLength(2);
    expect((await triggerRow(trigger.id)).pollClaimedBy).toBe("worker-9");

    // A claim older than five minutes belonged to a dead worker.
    await poll(github, after(200 + 5 * 60 + 1), "worker-1");
    expect(github.feedRequests()).toHaveLength(3);
    expect((await triggerRow(trigger.id)).pollClaimedBy).toBeNull();
  });

  it("waits out a rate limit without blaming the owner", async () => {
    const trigger = await addTrigger(alice, aliceSkillId);
    const reset = Math.floor(T0.getTime() / 1000) + 900;
    const feed: StubFeed = {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      },
    };
    const github = stubGitHub({ [ALICE_TOKEN]: feed });

    await poll(github, T0);
    const row = await triggerRow(trigger.id);
    expect(row.pollNextAt).toEqual(after(900));
    expect(row.lastError).toBeNull();
    expect(row.state).toMatchObject({ failures: 0, error: null });

    await poll(github, after(899));
    expect(github.feedRequests()).toHaveLength(1);
  });

  it("backs off on failures, reports them, and clears its own error on recovery", async () => {
    const trigger = await addTrigger(alice, aliceSkillId);
    const feed: StubFeed = { status: 502 };
    const github = stubGitHub({ [ALICE_TOKEN]: feed });

    await expect(poll(github, T0)).resolves.toEqual({ polled: 1, failed: 0 });
    let row = await triggerRow(trigger.id);
    expect(row.state?.failures).toBe(1);
    expect(row.pollNextAt).toEqual(after(120));
    expect(row.lastError).toBe(
      "GitHub could not be reached. Comparative will keep trying.",
    );

    await poll(github, after(121));
    row = await triggerRow(trigger.id);
    expect(row.state?.failures).toBe(2);
    expect(row.pollNextAt).toEqual(after(121 + 240));

    feed.status = undefined;
    feed.etag = 'W/"v1"';
    feed.events = [];
    await poll(github, after(121 + 241));
    row = await triggerRow(trigger.id);
    expect(row.state).toMatchObject({ failures: 0, error: null });
    expect(row.lastError).toBeNull();
  });

  it("survives a GitHub that throws, and a pull request it cannot read yet", async () => {
    const trigger = await addTrigger(alice, aliceSkillId);
    const throwing = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    await expect(
      processDueGitHubEventPolls({
        db,
        workerId: "worker-1",
        now: T0,
        fetchImpl: throwing,
      }),
    ).resolves.toEqual({ polled: 1, failed: 0 });
    expect((await triggerRow(trigger.id)).state?.failures).toBe(1);

    const feed: StubFeed = {
      etag: 'W/"v1"',
      events: [
        reviewFeedEvent({ id: "20000000101", createdAt: "2026-11-18T10:00:30Z" }),
      ],
      pullRequestStatus: 500,
    };
    const github = stubGitHub({ [ALICE_TOKEN]: feed });
    await poll(github, after(121));
    let row = await triggerRow(trigger.id);
    // The event is neither fired nor forgotten: no ETag, so the next poll
    // reads the feed again.
    expect(await runsOf(trigger.id)).toHaveLength(0);
    expect(row.state).toMatchObject({ etag: null, seenEventIds: [] });

    feed.pullRequestStatus = undefined;
    await poll(github, new Date(row.pollNextAt!.getTime() + 1000));
    row = await triggerRow(trigger.id);
    expect(await runsOf(trigger.id)).toHaveLength(1);
    expect(row.state).toMatchObject({ etag: 'W/"v1"', failures: 0 });
    expect(row.lastError).toBeNull();
  });

  it("pages back only as far as the previous poll", async () => {
    const trigger = await addTrigger(alice, aliceSkillId);
    const feed: StubFeed = { etag: 'W/"v1"', events: [] };
    const github = stubGitHub({ [ALICE_TOKEN]: feed });
    await poll(github, T0);

    // A busy minute: page one is all newer than the last poll, and the review
    // sits on page two.
    feed.etag = 'W/"v2"';
    feed.events = unsupportedFeedEvents.map((event) => ({
      ...event,
      created_at: "2026-11-18T10:00:50Z",
    }));
    feed.pages = [
      [
        reviewFeedEvent({ id: "20000000101", createdAt: "2026-11-18T10:00:30Z" }),
        reviewFeedEvent({ id: "20000000050", createdAt: "2026-11-18T09:00:00Z" }),
      ],
      [reviewFeedEvent({ id: "20000000001", createdAt: "2026-11-01T09:00:00Z" })],
    ];
    await poll(github, after(61));

    expect(github.feedRequests().map((request) => request.path)).toEqual([
      "/repos/octo-org/widgets/events?per_page=100",
      "/repos/octo-org/widgets/events?per_page=100",
      "/repos/octo-org/widgets/events?per_page=100&page=2",
    ]);
    const fired = await runsOf(trigger.id);
    expect(fired.map((run) => run.eventDeliveryId)).toEqual(["20000000101"]);
  });

  it("never lets an event polled with one user's token fire another user's trigger", async () => {
    const aliceTrigger = await addTrigger(alice, aliceSkillId);
    const bobTrigger = await addTrigger(bob, bobSkillId);
    // Bob has a trigger on the same repository, but his token cannot read it.
    const feed: StubFeed = { etag: 'W/"v1"', events: [] };
    const github = stubGitHub({ [ALICE_TOKEN]: feed });
    await poll(github, T0);

    feed.etag = 'W/"v2"';
    feed.events = [
      reviewFeedEvent({ id: "20000000101", createdAt: "2026-11-18T10:00:30Z" }),
    ];
    const bobBackoff = (await triggerRow(bobTrigger.id)).pollNextAt!;
    await poll(github, new Date(bobBackoff.getTime() + 1000));

    expect(await runsOf(aliceTrigger.id)).toHaveLength(1);
    expect(await runsOf(bobTrigger.id)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(eventTriggerDeliveries)
        .where(eq(eventTriggerDeliveries.triggerId, bobTrigger.id)),
    ).toHaveLength(0);
    expect(await db.select().from(runs).where(eq(runs.userId, bob.id))).toEqual(
      [],
    );
    const bobRow = await triggerRow(bobTrigger.id);
    expect(bobRow.lastError).toMatch(/cannot read this repository's events/);
    expect(bobRow.state?.seenEventIds).toEqual([]);

    // Each owner's poll carried that owner's token and no other.
    const tokens = new Set(github.requests.map((request) => request.token));
    expect(tokens).toEqual(new Set([ALICE_TOKEN, BOB_TOKEN]));
    expect(
      github.requests.filter((request) => request.path.includes("/pulls/")),
    ).toEqual([
      expect.objectContaining({ token: ALICE_TOKEN }),
    ]);

    // The pipeline enforces it too: naming Bob's trigger in a poll scoped to
    // Alice reaches nothing, whereas an unscoped webhook reaches both.
    const event = normalizeGitHubWebhookEvent(
      "pull_request_review",
      reviewWebhookPayload(),
    )!;
    await expect(
      processGitHubWebhookEvent({
        db,
        deliveryId: "20000000999",
        event,
        scope: { userId: alice.id, triggerIds: [bobTrigger.id] },
      }),
    ).resolves.toMatchObject({ matched: 0, fired: 0 });
    await expect(
      processGitHubWebhookEvent({
        db,
        deliveryId: "20000000998",
        event,
        scope: { userId: bob.id, triggerIds: [aliceTrigger.id] },
      }),
    ).resolves.toMatchObject({ matched: 0, fired: 0 });
    expect(await runsOf(bobTrigger.id)).toHaveLength(0);
  });

  it("drops a feed entry that names a different repository", async () => {
    const widgets = await addTrigger(alice, aliceSkillId);
    const other = await addTrigger(alice, aliceSkillId, {
      repository: "octo-org/other",
    });
    const feed: StubFeed = {
      etag: 'W/"v1"',
      events: [],
      onlyRepository: FEED_REPOSITORY,
    };
    const github = stubGitHub({ [ALICE_TOKEN]: feed });
    await poll(github, T0);

    // The widgets feed lists a review that claims to be from the other
    // repository, whose own feed is empty.
    feed.etag = 'W/"v2"';
    feed.events = [
      reviewFeedEvent({
        id: "20000000101",
        createdAt: "2026-11-18T10:00:30Z",
        repository: "octo-org/other",
      }),
    ];
    await poll(github, after(61));

    expect(github.feedRequests()).toHaveLength(4);
    expect(await runsOf(widgets.id)).toHaveLength(0);
    expect(await runsOf(other.id)).toHaveLength(0);
  });

  it("stops polling when the owner's GitHub approval is revoked", async () => {
    const trigger = await addTrigger(alice, aliceSkillId);
    await db
      .update(userToolAttestations)
      .set({ revokedAt: new Date() })
      .where(eq(userToolAttestations.userId, alice.id));
    const github = stubGitHub({ [ALICE_TOKEN]: { events: [] } });

    await poll(github, T0);

    expect(github.requests).toHaveLength(0);
    expect((await triggerRow(trigger.id)).lastError).toBe(
      "Approve GitHub administrative access so this trigger can check the repository for new events.",
    );
  });

  it("never polls for a failed-CI trigger, a paused one or a deleted one", async () => {
    await addTrigger(alice, aliceSkillId, {
      eventType: "workflow_run",
      action: "completed",
    });
    await addTrigger(alice, aliceSkillId, { enabled: false });
    await addTrigger(alice, aliceSkillId, { deletedAt: new Date() });
    const github = stubGitHub({ [ALICE_TOKEN]: { events: [] } });

    await expect(poll(github, T0)).resolves.toEqual({ polled: 0, failed: 0 });
    expect(github.requests).toHaveLength(0);
  });

  it("creates a trigger in poll mode without a webhook, and refuses failed CI", async () => {
    vi.stubEnv("GITHUB_EVENT_INGEST_MODE", "poll");
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
    const github = stubGitHub({ [ALICE_TOKEN]: { events: [] } });
    vi.stubGlobal("fetch", github.fetchImpl);
    const { POST } = await import("@/app/api/event-triggers/route");
    const create = (user: SessionUser, skillId: string, kind: string) => {
      currentUser = user;
      return POST(
        new Request("http://test.local/api/event-triggers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ skillId, repository: FEED_REPOSITORY, kind }),
        }),
      );
    };

    const refused = await create(alice, aliceSkillId, "workflow_run_failure");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: "event_trigger_unavailable",
      message: expect.stringContaining("does not include workflow runs"),
    });
    expect(github.requests).toHaveLength(0);

    const created = await create(alice, aliceSkillId, "pull_request_review");
    expect(created.status).toBe(201);
    // One read of the feed with the owner's token; no webhook was installed.
    expect(github.requests).toEqual([
      {
        path: "/repos/octo-org/widgets/events?per_page=1",
        token: ALICE_TOKEN,
        ifNoneMatch: null,
      },
    ]);

    // Bob's token cannot read the repository, so his trigger would never fire.
    const unreadable = await create(bob, bobSkillId, "pull_request_review");
    expect(unreadable.status).toBe(403);
    expect(await unreadable.json()).toMatchObject({
      error: "github_repository_access_required",
    });

    const rows = await db.select().from(eventTriggers);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: alice.id,
      eventType: "pull_request_review",
      pollState: null,
    });
  });

  it("acceptance: one review fires the same run by webhook and by poll", async () => {
    const stripNonce = (prompt: string) =>
      prompt.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<nonce>");
    const firedRun = async (triggerId: string) => {
      const rows = await runsOf(triggerId);
      expect(rows).toHaveLength(1);
      const inputs = rows[0]!.inputs as {
        prompt: string;
        githubEvent: Record<string, unknown>;
      };
      return {
        triggerType: rows[0]!.triggerType,
        prompt: stripNonce(inputs.prompt),
        event: { ...inputs.githubEvent, deliveryId: null },
      };
    };

    // Webhook mode: GitHub posts the signed delivery to the real route.
    const webhookTrigger = await addTrigger(alice, aliceSkillId);
    vi.stubEnv("GITHUB_EVENT_INGEST_MODE", "webhook");
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", WEBHOOK_SECRET);
    const body = JSON.stringify(reviewWebhookPayload());
    const deliver = async () => {
      const { POST } = await import("@/app/api/webhooks/github/route");
      return POST(
        new Request("http://test.local/api/webhooks/github", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-delivery": "5f0c2d5e-0000-4000-8000-000000000101",
            "x-github-event": "pull_request_review",
            "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET)
              .update(body)
              .digest("hex")}`,
          },
          body,
        }),
      );
    };
    const delivered = await deliver();
    expect(delivered.status).toBe(202);
    expect(await delivered.json()).toMatchObject({ matched: 1, fired: 1 });
    const byWebhook = await firedRun(webhookTrigger.id);

    // Poll mode: the route is gone, and the poller reads the same review from
    // the feed.
    await db
      .update(eventTriggers)
      .set({ enabled: false })
      .where(eq(eventTriggers.id, webhookTrigger.id));
    const pollTrigger = await addTrigger(alice, aliceSkillId);
    vi.stubEnv("GITHUB_EVENT_INGEST_MODE", "poll");
    vi.resetModules();
    expect((await deliver()).status).toBe(404);

    const feed: StubFeed = { etag: 'W/"v1"', events: [] };
    const github = stubGitHub({ [ALICE_TOKEN]: feed });
    await poll(github, T0);
    feed.etag = 'W/"v2"';
    feed.events = [
      reviewFeedEvent({ id: "20000000101", createdAt: "2026-11-18T10:00:30Z" }),
    ];
    await poll(github, after(61));
    const byPoll = await firedRun(pollTrigger.id);

    expect(byPoll).toEqual(byWebhook);
    expect(byPoll.triggerType).toBe("github_event");
    expect(byPoll.prompt).toContain("SECURITY BOUNDARY");
    expect(byPoll.prompt).toContain("<<<GITHUB-EVENT-DATA <nonce>>>>");
    // The paused webhook-mode trigger got nothing from the poll.
    expect(
      await db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.eventTriggerId, webhookTrigger.id),
            eq(runs.eventDeliveryId, "20000000101"),
          ),
        ),
    ).toHaveLength(0);
  });
});
