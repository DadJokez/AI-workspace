import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_ID } from "@ai-workspace/agent";
import type { Database, MemoryCaptureQueueItem, UserMemoryItem } from "@ai-workspace/db";
import type { SQL } from "drizzle-orm";
import { getTableName, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * The largest previously-untested module in the app (645 lines) — and its
 * failure mode is silent: memories just stop appearing. Only the model client
 * (`getRuntime`) is mocked; the queue claim, review-document assembly, model
 * resolution, suggestion normalization, and terminal marking all run real
 * against a table-keyed chainable db fake.
 *
 * NOTE (#462 / PR #486): the queue-bounds branch adds
 * `sweepSettledMemoryCaptures` plus its own describe blocks to this same
 * file. These blocks are additive — merge by union.
 */

let scriptedTurnEvents: Array<
  { type: "text-delta"; delta: string } | { type: "error"; message: string }
> = [];
let lastTurnInput:
  | {
      threadId: string;
      modelId: string;
      systemPrompt?: string;
      messages: Array<{ role: string; content: string }>;
    }
  | undefined;
vi.mock("@ai-workspace/agent-runtime", () => ({
  getRuntime: vi.fn(() => ({
    name: "bedrock",
    runTurn: async function* (input: typeof lastTurnInput & object) {
      lastTurnInput = input as typeof lastTurnInput;
      yield* scriptedTurnEvents;
    },
  })),
}));

import {
  backfillMissingMemoryCaptures,
  enqueueMemoryCapture,
  processPendingMemoryCaptures,
  sweepSettledMemoryCaptures,
} from "@/lib/memory-capture";

/**
 * Chainable fake for the Drizzle query builder, dispatching select results by
 * TABLE rather than call order so module-level caches (model enablement)
 * cannot skew the sequence. Each table's results dequeue per select; the last
 * entry is sticky. Updates capture (set, where) and serve `updateReturning`;
 * inserts capture their values.
 */
function fakeDb(config: {
  selects?: Record<string, Array<Array<Record<string, unknown>>>>;
  updateReturning?: Record<string, Array<Array<Record<string, unknown>>>>;
  insertReturning?: Record<string, Array<Array<Record<string, unknown>>>>;
}) {
  const selects = config.selects ?? {};
  const updateReturning = config.updateReturning ?? {};
  const insertReturning = config.insertReturning ?? {};
  const captured: {
    updates: Array<{ table: string; set: Record<string, unknown>; where: SQL }>;
    inserts: Array<{ table: string; values: unknown }>;
    deletes: Array<{ table: string; where: SQL }>;
  } = { updates: [], inserts: [], deletes: [] };

  const dequeue = (
    queues: Record<string, Array<Array<Record<string, unknown>>>>,
    table: string,
  ) => {
    const queue = queues[table] ?? [];
    return (queue.length > 1 ? queue.shift() : queue[0]) ?? [];
  };

  const db = {
    select: () => ({
      from: (table: Table) => {
        const pending = () => Promise.resolve(dequeue(selects, getTableName(table)));
        const chain: Record<string, unknown> = {
          leftJoin: () => chain,
          where: () => chain,
          orderBy: () => chain,
          limit: () => chain,
          then: (
            onFulfilled: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => pending().then(onFulfilled, onRejected),
        };
        return chain;
      },
    }),
    update: (table: Table) => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: SQL) => {
          captured.updates.push({ table: getTableName(table), set, where });
          const pending = Promise.resolve(undefined);
          return Object.assign(pending, {
            returning: async () => dequeue(updateReturning, getTableName(table)),
          });
        },
      }),
    }),
    insert: (table: Table) => ({
      values: (values: unknown) => {
        const tableName = getTableName(table);
        captured.inserts.push({ table: tableName, values });
        const pending = Promise.resolve(undefined);
        const chain = Object.assign(pending, {
          onConflictDoNothing: () => chain,
          returning: async () => dequeue(insertReturning, tableName),
        });
        return chain;
      },
    }),
    // #462's retention sweep runs at the top of every processing pass.
    delete: (table: Table) => ({
      where: (where: SQL) => {
        captured.deletes.push({ table: getTableName(table), where });
        return Promise.resolve();
      },
    }),
  } as unknown as Database;

  return { db, captured };
}

function renderCondition(condition: SQL) {
  return new PgDialect().sqlToQuery(condition);
}

function queueItem(
  overrides: Partial<MemoryCaptureQueueItem> = {},
): MemoryCaptureQueueItem {
  return {
    id: "cap-1",
    userId: "user-1",
    threadId: "thread-1",
    fromMessageId: "msg-1",
    toMessageId: "msg-2",
    runId: "run-1",
    reason: "chat_turn",
    status: "pending",
    attemptCount: 0,
    error: null,
    claimedAt: null,
    processedAt: null,
    createdAt: new Date("2026-07-19T10:00:00Z"),
    updatedAt: new Date("2026-07-19T10:00:00Z"),
    ...overrides,
  } as MemoryCaptureQueueItem;
}

function approvedMemory(
  overrides: Partial<UserMemoryItem> = {},
): UserMemoryItem {
  return {
    id: "mem-1",
    userId: "user-1",
    status: "approved",
    category: "preferences",
    title: "Prefers TypeScript",
    bodyMd: "- Prefers TypeScript for new services.",
    confidence: 90,
    reason: null,
    sourceThreadId: null,
    sourceMessageIds: [],
    suggestedBy: "memory-capture",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  } as unknown as UserMemoryItem;
}

const messageRows = [
  {
    id: "msg-1",
    role: "user",
    content: "please remember I deploy only on Tuesdays",
    createdAt: new Date("2026-07-19T09:00:00Z"),
  },
  {
    id: "msg-2",
    role: "assistant",
    content: "Noted - Tuesday-only deploys.",
    createdAt: new Date("2026-07-19T09:01:00Z"),
  },
];

const enablementRows = [{ modelId: "sonnet-4-6", purpose: "memory-capture" }];

function happyPathDb(options: {
  pending?: MemoryCaptureQueueItem[];
  activeMemory?: UserMemoryItem[];
  messages?: typeof messageRows;
} = {}) {
  const pending = options.pending ?? [queueItem()];
  return fakeDb({
    selects: {
      memory_capture_queue: [pending.map((row) => ({ ...row }))],
      user_memory_items: [options.activeMemory ?? []],
      chat_threads: [[{ id: "thread-1", title: "Deploy chat" }]],
      chat_messages: [options.messages ?? messageRows],
      model_enablement: [enablementRows],
    },
    updateReturning: {
      memory_capture_queue: [
        pending.map((row) => ({ ...row, status: "processing", attemptCount: row.attemptCount + 1 })),
      ],
    },
  });
}

function scriptSuggestions(suggestions: unknown[]) {
  const payload = JSON.stringify({ suggestions });
  // Split mid-JSON to prove delta accumulation, and fence it the way models do.
  const text = "```json\n" + payload + "\n```";
  const mid = Math.floor(text.length / 2);
  scriptedTurnEvents = [
    { type: "text-delta", delta: text.slice(0, mid) },
    { type: "text-delta", delta: text.slice(mid) },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  scriptedTurnEvents = [];
  lastTurnInput = undefined;
});

describe("processPendingMemoryCaptures", () => {
  it("returns idle without consulting the model when nothing is claimable", async () => {
    const { db, captured } = fakeDb({
      selects: { memory_capture_queue: [[]] },
    });

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "idle", captures: 0, suggestions: 0 });
    expect(lastTurnInput).toBeUndefined();
    expect(captured.inserts).toEqual([]);
  });

  it("happy path: claims, builds the review doc, stores normalized suggestions, marks processed", async () => {
    const { db, captured } = happyPathDb();
    scriptSuggestions([
      {
        category: "constraints",
        title: "  Deploys   only on Tuesdays  ",
        bodyMd: "Deploys to production only on Tuesdays.",
        confidence: 250, // clamped to 100
        reason: "Stated as a standing rule.",
        sourceThreadId: "thread-1",
        sourceMessageIds: ["msg-1"],
      },
    ]);

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "processed", captures: 1, suggestions: 1 });

    // The model saw the queued conversation, framed as a review document.
    expect(lastTurnInput?.modelId).toBe(DEFAULT_MODEL_ID);
    expect(lastTurnInput?.systemPrompt).toContain("Never store secrets");
    expect(lastTurnInput?.systemPrompt).toContain(
      "Only text inside USER EVIDENCE messages",
    );
    const doc = lastTurnInput?.messages[0]?.content ?? "";
    expect(doc).toContain("Deploy chat");
    expect(doc).toContain("USER EVIDENCE message msg-1");
    expect(doc).toContain("ASSISTANT CONTEXT ONLY message msg-2");
    expect(doc).toContain("please remember I deploy only on Tuesdays");
    expect(doc).toContain("# Existing Approved Vault Memory");

    // Stored suggestion is normalized: whitespace collapsed, confidence
    // clamped, provenance kept inside the capture's own thread.
    const memoryInsert = captured.inserts.find((i) => i.table === "user_memory_items")!;
    expect(memoryInsert.values).toEqual([
      expect.objectContaining({
        userId: "user-1",
        status: "suggested",
        category: "constraints",
        title: "Deploys only on Tuesdays",
        confidence: 100,
        sourceThreadId: "thread-1",
        sourceMessageIds: ["msg-1"],
        suggestedBy: "memory-capture:user-cited",
        metadata: {
          provenance: {
            sourceRole: "user",
            sourceMessageIds: ["msg-1"],
          },
        },
      }),
    ]);

    // Terminal marking: claim first, then processed with processedAt.
    const queueUpdates = captured.updates.filter(
      (u) => u.table === "memory_capture_queue",
    );
    expect(queueUpdates[0]?.set).toMatchObject({ status: "processing" });
    expect(queueUpdates.at(-1)?.set).toMatchObject({ status: "processed" });
    expect(queueUpdates.at(-1)?.set.processedAt).toBeInstanceOf(Date);
  });

  it("skips captures with no loadable messages without consulting the model", async () => {
    const pending = queueItem();
    const { db, captured } = fakeDb({
      selects: {
        memory_capture_queue: [[pending]],
        user_memory_items: [[]],
        chat_threads: [[{ id: "thread-1", title: "Missing chat" }]],
        chat_messages: [[]],
      },
      updateReturning: {
        memory_capture_queue: [
          [{ ...pending, status: "processing", attemptCount: 1 }],
        ],
      },
    });

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "processed", captures: 1, suggestions: 0 });
    expect(lastTurnInput).toBeUndefined();
    expect(
      captured.updates
        .filter((update) => update.table === "memory_capture_queue")
        .map((update) => update.set.status),
    ).toEqual(["processing", "skipped"]);
  });

  it("keeps empty captures skipped when another capture in the group fails", async () => {
    const empty = queueItem({ id: "cap-empty", threadId: "thread-empty" });
    const material = queueItem({
      id: "cap-material",
      threadId: "thread-material",
    });
    const { db, captured } = fakeDb({
      selects: {
        memory_capture_queue: [[empty, material]],
        user_memory_items: [[]],
        chat_threads: [
          [
            { id: "thread-empty", title: "Missing chat" },
            { id: "thread-material", title: "Deploy chat" },
          ],
        ],
        chat_messages: [[], messageRows],
        model_enablement: [enablementRows],
      },
      updateReturning: {
        memory_capture_queue: [
          [
            { ...empty, status: "processing", attemptCount: 1 },
            { ...material, status: "processing", attemptCount: 1 },
          ],
        ],
      },
    });
    scriptedTurnEvents = [
      { type: "error", message: "bedrock throttled the request" },
    ];

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "failed", captures: 2, suggestions: 0 });
    const queueUpdates = captured.updates.filter(
      (update) => update.table === "memory_capture_queue",
    );
    expect(queueUpdates.map((update) => update.set.status)).toEqual([
      "processing",
      "skipped",
      "failed",
    ]);
    expect(renderCondition(queueUpdates[1]!.where).params).toEqual(["cap-empty"]);
    expect(renderCondition(queueUpdates[2]!.where).params).toEqual([
      "cap-material",
    ]);
  });

  it("rejects assistant-only and out-of-range provenance", async () => {
    const { db, captured } = happyPathDb();
    scriptSuggestions([
      {
        category: "projects",
        title: "Working on the deploy pipeline",
        bodyMd: "Owns the deploy pipeline work.",
        confidence: 70,
        // The model attributes the memory to a thread/messages OUTSIDE the
        // captured window — a poisoning vector if trusted verbatim.
        sourceThreadId: "someone-elses-thread",
        sourceMessageIds: ["foreign-msg-1", "msg-2"],
      },
    ]);

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "processed", captures: 1, suggestions: 0 });
    expect(
      captured.inserts.filter((insert) => insert.table === "user_memory_items"),
    ).toEqual([]);
  });

  it("rejects an assistant-invented calendar date even when attributed to the user", async () => {
    const pilotMessages = [
      {
        id: "msg-1",
        role: "user" as const,
        content:
          "I am launching a pilot next Tuesday with 5 testers and will review results Friday.",
        createdAt: new Date("2026-07-24T09:00:00Z"),
      },
      {
        id: "msg-2",
        role: "assistant" as const,
        content:
          "Pilot launches July 28, 2026; review results Friday, August 1, 2026.",
        createdAt: new Date("2026-07-24T09:01:00Z"),
      },
    ];
    const { db, captured } = happyPathDb({ messages: pilotMessages });
    scriptSuggestions([
      {
        category: "current_priorities",
        title: "Pilot launch July 28, 2026",
        bodyMd:
          "Launch with 5 testers next Tuesday and review results Friday, August 1, 2026.",
        confidence: 88,
        reason: "The pilot has durable deadlines.",
        sourceThreadId: "thread-1",
        sourceMessageIds: ["msg-1"],
      },
    ]);

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "processed", captures: 1, suggestions: 0 });
    expect(
      captured.inserts.filter((insert) => insert.table === "user_memory_items"),
    ).toEqual([]);
  });

  it("keeps a grounded memory when may is a modal verb", async () => {
    const { db, captured } = happyPathDb({
      messages: [
        {
          id: "msg-1",
          role: "user" as const,
          content: "I sometimes deploy on weekends.",
          createdAt: new Date("2026-07-24T09:00:00Z"),
        },
      ],
    });
    scriptSuggestions([
      {
        category: "preferences",
        title: "Weekend deploys",
        bodyMd: "The user may deploy on weekends.",
        confidence: 82,
        reason: "This is a recurring working preference.",
        sourceThreadId: "thread-1",
        sourceMessageIds: ["msg-1"],
      },
    ]);

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "processed", captures: 1, suggestions: 1 });
    expect(
      captured.inserts.find(
        (insert) => insert.table === "user_memory_items",
      )?.values,
    ).toEqual([
      expect.objectContaining({
        title: "Weekend deploys",
        bodyMd: "The user may deploy on weekends.",
      }),
    ]);
  });

  it("still rejects an invented May date when its day number appears elsewhere", async () => {
    const { db, captured } = happyPathDb({
      messages: [
        {
          id: "msg-1",
          role: "user" as const,
          content: "I sometimes deploy on weekends and maintain 28 services.",
          createdAt: new Date("2026-07-24T09:00:00Z"),
        },
      ],
    });
    scriptSuggestions([
      {
        category: "preferences",
        title: "Weekend deploys",
        bodyMd: "The user may deploy on May 28.",
        confidence: 82,
        reason: "This is a recurring working preference.",
        sourceThreadId: "thread-1",
        sourceMessageIds: ["msg-1"],
      },
    ]);

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "processed", captures: 1, suggestions: 0 });
    expect(
      captured.inserts.filter(
        (insert) => insert.table === "user_memory_items",
      ),
    ).toEqual([]);
  });

  it("keeps user-stated relative dates and collapses equivalent proposals", async () => {
    const pilotMessages = [
      {
        id: "msg-1",
        role: "user" as const,
        content:
          "I am launching a pilot next Tuesday with 5 testers and will review results Friday.",
        createdAt: new Date("2026-07-24T09:00:00Z"),
      },
      {
        id: "msg-2",
        role: "assistant" as const,
        content: "I can help plan that.",
        createdAt: new Date("2026-07-24T09:01:00Z"),
      },
    ];
    const { db, captured } = happyPathDb({ messages: pilotMessages });
    scriptSuggestions([
      {
        category: "current_priorities",
        title: "Pilot launch",
        bodyMd:
          "Pilot launches next Tuesday with 5 testers and results are reviewed Friday.",
        confidence: 88,
        reason: "The user stated this active pilot plan.",
        sourceThreadId: "thread-1",
        sourceMessageIds: ["msg-1"],
      },
      {
        category: "current_priorities",
        title: "Pilot launch next Tuesday",
        bodyMd:
          "The pilot launches next Tuesday with 5 testers, with results reviewed Friday.",
        confidence: 87,
        reason: "The user stated this active pilot plan.",
        sourceThreadId: "thread-1",
        sourceMessageIds: ["msg-1"],
      },
    ]);

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "processed", captures: 1, suggestions: 1 });
    const memoryInsert = captured.inserts.find(
      (insert) => insert.table === "user_memory_items",
    )!;
    expect(memoryInsert.values).toEqual([
      expect.objectContaining({
        title: "Pilot launch",
        sourceMessageIds: ["msg-1"],
        suggestedBy: "memory-capture:user-cited",
      }),
    ]);
  });

  it("does not reject a grounded memory because reviewer rationale adds facts", async () => {
    const { db, captured } = happyPathDb({
      messages: [
        {
          id: "msg-1",
          role: "user" as const,
          content: "I deploy production changes only on Tuesdays.",
          createdAt: new Date("2026-07-24T09:00:00Z"),
        },
      ],
    });
    scriptSuggestions([
      {
        category: "constraints",
        title: "Production deploy day",
        bodyMd: "Production changes are deployed only on Tuesdays.",
        confidence: 91,
        reason: "The reviewer checked this Monday and recommends revisiting in 7 days.",
        sourceThreadId: "thread-1",
        sourceMessageIds: ["msg-1"],
      },
    ]);

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "processed", captures: 1, suggestions: 1 });
    const memoryInsert = captured.inserts.find(
      (insert) => insert.table === "user_memory_items",
    )!;
    expect(memoryInsert.values).toEqual([
      expect.objectContaining({
        title: "Production deploy day",
        reason:
          "The reviewer checked this Monday and recommends revisiting in 7 days.",
        suggestedBy: "memory-capture:user-cited",
      }),
    ]);
  });

  it("does not repeat an equivalent active suggestion on a later capture run", async () => {
    const pilotMessages = [
      {
        id: "msg-1",
        role: "user" as const,
        content:
          "I am launching a pilot next Tuesday with 5 testers and will review results Friday.",
        createdAt: new Date("2026-07-24T09:00:00Z"),
      },
      {
        id: "msg-2",
        role: "assistant" as const,
        content: "I can help plan that.",
        createdAt: new Date("2026-07-24T09:01:00Z"),
      },
    ];
    const existing = approvedMemory({
      id: "mem-existing-pilot",
      status: "suggested",
      category: "current_priorities",
      title: "Pilot launch",
      bodyMd:
        "Pilot launches next Tuesday with 5 testers and results are reviewed Friday.",
    });
    const { db, captured } = happyPathDb({
      activeMemory: [existing],
      messages: pilotMessages,
    });
    scriptSuggestions([
      {
        category: "current_priorities",
        title: "Pilot launch next Tuesday",
        bodyMd:
          "The pilot launches next Tuesday for 5 testers, with results reviewed Friday.",
        confidence: 88,
        reason: "The user stated this active pilot plan.",
        sourceThreadId: "thread-1",
        sourceMessageIds: ["msg-1"],
      },
    ]);

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "processed", captures: 1, suggestions: 0 });
    expect(
      captured.inserts.filter((insert) => insert.table === "user_memory_items"),
    ).toEqual([]);
  });

  it("drops suggestions that duplicate existing memory instead of re-inserting them", async () => {
    const { db, captured } = happyPathDb({ activeMemory: [approvedMemory()] });
    scriptSuggestions([
      {
        category: "preferences",
        title: "Prefers TypeScript",
        bodyMd: "- Prefers TypeScript for new services.",
        confidence: 80,
        sourceMessageIds: ["msg-1"],
      },
    ]);

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "processed", captures: 1, suggestions: 0 });
    expect(captured.inserts.filter((i) => i.table === "user_memory_items")).toEqual([]);
  });

  it("marks the group failed with the model's error when the runtime reports one", async () => {
    const { db, captured } = happyPathDb();
    scriptedTurnEvents = [
      { type: "text-delta", delta: "partial" },
      { type: "error", message: "bedrock throttled the request" },
    ];

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "failed", captures: 1, suggestions: 0 });
    const failedUpdate = captured.updates
      .filter((u) => u.table === "memory_capture_queue")
      .at(-1)!;
    expect(failedUpdate.set).toMatchObject({
      status: "failed",
      error: "bedrock throttled the request",
    });
    expect(failedUpdate.set.processedAt).toBeInstanceOf(Date);
    expect(captured.inserts.filter((i) => i.table === "user_memory_items")).toEqual([]);
  });

  it("marks the group failed when the model returns unparseable JSON (poison output)", async () => {
    const { db, captured } = happyPathDb();
    scriptedTurnEvents = [
      { type: "text-delta", delta: "I think the user likes { unquoted json" },
    ];

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "failed", captures: 1, suggestions: 0 });
    const failedUpdate = captured.updates
      .filter((u) => u.table === "memory_capture_queue")
      .at(-1)!;
    expect(failedUpdate.set.status).toBe("failed");
    expect(failedUpdate.set.error).toBeTruthy();
  });

  it("a failing user's group does not block another user's captures in the same batch", async () => {
    const alice = queueItem({ id: "cap-a", userId: "user-a", threadId: "thread-1" });
    const bob = queueItem({ id: "cap-b", userId: "user-b", threadId: "thread-1" });
    const { db, captured } = fakeDb({
      selects: {
        memory_capture_queue: [[alice, bob]],
        user_memory_items: [[]],
        chat_threads: [[{ id: "thread-1", title: "Shared title" }]],
        chat_messages: [messageRows],
        model_enablement: [enablementRows],
      },
      updateReturning: {
        memory_capture_queue: [
          [
            { ...alice, status: "processing" },
            { ...bob, status: "processing" },
          ],
        ],
      },
    });
    // First group (alice) gets poison output; second (bob) gets a clean one.
    let call = 0;
    scriptedTurnEvents = [];
    const { getRuntime } = await import("@ai-workspace/agent-runtime");
    vi.mocked(getRuntime).mockReturnValue({
      name: "bedrock",
      runTurn: async function* () {
        call += 1;
        if (call === 1) {
          yield { type: "error", message: "boom for alice" };
        } else {
          yield {
            type: "text-delta",
            delta: '{"suggestions":[{"category":"projects","title":"Bob project","bodyMd":"Bob is shipping.","confidence":60,"sourceMessageIds":["msg-1"]}]}',
          };
        }
      },
    } as unknown as ReturnType<typeof getRuntime>);

    const result = await processPendingMemoryCaptures({ db });

    // One group failed, one processed; the pass reports failed but bob's
    // suggestion still landed.
    expect(result).toEqual({ status: "failed", captures: 2, suggestions: 1 });
    const statuses = captured.updates
      .filter((u) => u.table === "memory_capture_queue")
      .map((u) => u.set.status);
    expect(statuses).toContain("failed");
    expect(statuses).toContain("processed");
    expect(
      captured.inserts.filter((i) => i.table === "user_memory_items"),
    ).toHaveLength(1);
  });
});

describe("claim discipline (retry + poison-row)", () => {
  it("claims pending rows AND stale processing rows, incrementing attempt_count", async () => {
    const { db, captured } = fakeDb({
      selects: { memory_capture_queue: [[queueItem()]] },
      updateReturning: { memory_capture_queue: [[]] },
    });

    await processPendingMemoryCaptures({ db });

    const claim = captured.updates.find((u) => u.table === "memory_capture_queue")!;
    expect(claim.set).toMatchObject({ status: "processing" });
    // attempt_count rides a SQL increment, not a literal.
    expect(String(renderCondition(claim.set.attemptCount as SQL).sql)).toContain(
      "+",
    );
    const where = renderCondition(claim.where);
    // The claim predicate: pending, OR processing whose claim went stale —
    // the poison/crashed-worker row recovery path.
    expect(where.sql).toContain('"status" =');
    expect(where.sql).toContain("or");
    expect(where.sql).toContain('"claimed_at" <');
    expect(where.params).toContain("pending");
    expect(where.params).toContain("processing");
  });

  it("a row claimed by a live worker is not double-processed (conditional claim returned nothing)", async () => {
    // The select saw a pending row, but the guarded UPDATE ... RETURNING came
    // back empty because another worker claimed it in between.
    const { db, captured } = fakeDb({
      selects: { memory_capture_queue: [[queueItem()]] },
      updateReturning: { memory_capture_queue: [[]] },
    });

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "idle", captures: 0, suggestions: 0 });
    expect(lastTurnInput).toBeUndefined();
    // No terminal marking happened either — only the claim attempt ran.
    const queueUpdates = captured.updates.filter(
      (u) => u.table === "memory_capture_queue",
    );
    expect(queueUpdates).toHaveLength(1);
  });

  it("reclaims delayed failed rows below the attempt cap without an unbounded retry", async () => {
    const failed = queueItem({
      status: "failed",
      attemptCount: 1,
      processedAt: new Date("2026-07-19T08:00:00Z"),
      error: "temporary Bedrock outage",
    });
    const { db, captured } = fakeDb({
      selects: { memory_capture_queue: [[failed]] },
      updateReturning: { memory_capture_queue: [[]] },
    });

    await processPendingMemoryCaptures({ db });

    const claim = captured.updates.find(
      (update) => update.table === "memory_capture_queue",
    )!;
    expect(claim.set).toMatchObject({
      status: "processing",
      error: null,
      processedAt: null,
    });
    const where = renderCondition(claim.where);
    expect(where.params).toContain("failed");
    expect(where.params).toContain(3);
    expect(where.sql).toContain('"attempt_count" <');
    expect(where.sql).toContain('"processed_at" <');
  });

  it("scopes the claim to one user when userId is given", async () => {
    const { db, captured } = fakeDb({
      selects: { memory_capture_queue: [[]] },
    });

    await processPendingMemoryCaptures({ db, userId: "user-1" });

    // The pending SELECT is filterable only via its WHERE; with no rows the
    // claim update never runs, so assert on the absence of an unscoped claim.
    expect(
      captured.updates.filter((u) => u.table === "memory_capture_queue"),
    ).toEqual([]);
  });
});

describe("enqueueMemoryCapture", () => {
  it("inserts a pending row and tolerates duplicate enqueues via onConflictDoNothing", async () => {
    const { db, captured } = fakeDb({});

    await enqueueMemoryCapture(db, {
      userId: "user-1",
      threadId: "thread-1",
      fromMessageId: "msg-1",
      toMessageId: "msg-2",
      runId: "run-1",
    });

    expect(captured.inserts).toEqual([
      {
        table: "memory_capture_queue",
        values: {
          userId: "user-1",
          threadId: "thread-1",
          fromMessageId: "msg-1",
          toMessageId: "msg-2",
          runId: "run-1",
          reason: "chat_turn",
        },
      },
    ]);
  });
});

describe("backfillMissingMemoryCaptures", () => {
  it("queues only successful outage-window runs with both message endpoints", async () => {
    const { db, captured } = fakeDb({
      selects: {
        runs: [[
          {
            runId: "run-good",
            userId: "user-1",
            threadId: "thread-1",
            outputs: {
              userMessageId: "msg-1",
              assistantMessageId: "msg-2",
            },
          },
          {
            runId: "run-no-assistant",
            userId: "user-1",
            threadId: "thread-1",
            outputs: { userMessageId: "msg-3" },
          },
        ]],
      },
      insertReturning: {
        memory_capture_queue: [[{ id: "capture-restored" }]],
      },
    });

    const result = await backfillMissingMemoryCaptures(db, {
      since: new Date("2026-06-13T00:00:00Z"),
      until: new Date("2026-07-22T00:00:00Z"),
    });

    expect(result).toEqual({ candidates: 2, queued: 1 });
    expect(captured.inserts).toContainEqual({
      table: "memory_capture_queue",
      values: [{
        userId: "user-1",
        threadId: "thread-1",
        fromMessageId: "msg-1",
        toMessageId: "msg-2",
        runId: "run-good",
        reason: "outage_backfill",
      }],
    });
  });

  it("requires an explicit, forward-moving outage window", async () => {
    const { db } = fakeDb({});
    await expect(
      backfillMissingMemoryCaptures(db, {
        since: new Date("2026-07-22T00:00:00Z"),
        until: new Date("2026-06-13T00:00:00Z"),
      }),
    ).rejects.toThrow(/until must be after since/i);
  });
});

/**
 * #462's sweep tests, carried over in the union merge with the spine-coverage
 * suite above. Self-contained chainable fake (array-of-select-results shape)
 * kept under distinct names — the main suite's fakeDb takes a config object.
 */
function sweepFakeDb(selectResults: Array<Array<Record<string, unknown>>> = []) {
  const captured: { deleteWheres: SQL[] } = { deleteWheres: [] };
  const nextSelect = () => Promise.resolve(selectResults.shift() ?? []);
  function selectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => {
      const pending = nextSelect();
      return Object.assign(pending, {
        orderBy: () => pending,
        limit: () => pending,
      });
    };
    return chain;
  }
  const db = {
    select: () => selectChain(),
    delete: () => ({
      where: (condition: SQL) => {
        captured.deleteWheres.push(condition);
        return Promise.resolve();
      },
    }),
  } as unknown as Database;
  return { db, captured };
}

describe("sweepSettledMemoryCaptures (#462)", () => {
  it("keeps retryable failures and retains exhausted failures for 30 days", async () => {
    const { db, captured } = sweepFakeDb();
    const now = new Date("2026-07-19T12:00:00Z");

    await sweepSettledMemoryCaptures(db, now);

    expect(captured.deleteWheres).toHaveLength(1);
    const query = new PgDialect().sqlToQuery(captured.deleteWheres[0]!);
    expect(query.sql).toContain('"status" in (');
    expect(query.sql).toContain('"processed_at" <');
    expect(query.params).toEqual([
      "processed",
      "skipped",
      "2026-07-12T12:00:00.000Z",
      "failed",
      3,
      "2026-06-19T12:00:00.000Z",
    ]);
    expect(query.sql).toContain('"attempt_count" >=');
  });

  it("sweeps settled rows on every pass, even an idle one", async () => {
    const { db, captured } = sweepFakeDb();

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "idle", captures: 0, suggestions: 0 });
    expect(captured.deleteWheres).toHaveLength(1);
  });
});
