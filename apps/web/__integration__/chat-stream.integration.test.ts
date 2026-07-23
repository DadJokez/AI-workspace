import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@ai-workspace/agent";
import type { SessionUser } from "@ai-workspace/auth";
import { chatMessages, createDb, runs, users } from "@ai-workspace/db";
import { asc, eq } from "drizzle-orm";
import type { ChatStreamEvent } from "@/lib/chat-stream-contract";
import { readChatSseStream } from "@/lib/sse";

/**
 * The chat streaming spine, proven end-to-end at the cheapest layer that is
 * still real: the REAL /api/chat POST handler against real Postgres, with
 * ONLY the model/runtime seam stubbed (`getRuntime` — the same seam both
 * runtime lanes share). Events come back through `readSseStream` itself, so
 * the server's SSE framing and the client parser are exercised as one pipe.
 *
 * Covered: inline event ordering (meta -> model -> deltas -> usage ->
 * persisted -> done), terminal persistence (assistant message + run status),
 * provider errors and truncated streams (failed terminal, no persistence),
 * and the durable lane's explicit queued terminal event.
 */

const DB_URL = process.env.DATABASE_URL;

// The session mock: routes call getSessionUser(); tests choose the actor.
let currentUser: SessionUser | null = null;
vi.mock("@/lib/auth/getSessionUser", () => ({
  getSessionUser: async () => currentUser,
}));

// The runtime seam. Each test scripts the provider's event stream; the input
// is captured so the test can assert what the runtime was actually asked.
type RuntimeTurnInput = {
  threadId: string;
  modelId: string;
  messages: Array<{ role: string; content: string }>;
  systemPrompt?: string;
  onRunStarted?: (metadata: {
    runtime: string;
    providerRunId?: string;
  }) => void | Promise<void>;
};
let scriptedEvents: AgentEvent[] = [];
let lastTurnInput: RuntimeTurnInput | undefined;
vi.mock("@ai-workspace/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getRuntime: () => ({
      name: "bedrock",
      runTurn: async function* (input: RuntimeTurnInput) {
        lastTurnInput = input;
        await input.onRunStarted?.({
          runtime: "bedrock",
          providerRunId: "stub-run-1",
        });
        yield* scriptedEvents;
      },
    }),
  };
});

// The durable lane hands off to a detached in-process worker; that handoff is
// asserted, not executed, so the test never races a background run.
vi.mock("@/lib/chat-run-worker", () => ({
  startInProcessChatRunWorker: vi.fn(),
}));

async function postChat(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await import("@/app/api/chat/route");
  return POST(
    new Request("http://test.local/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function collectSse(res: Response): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of readChatSseStream(res)) events.push(event);
  return events;
}

const suite = describe.skipIf(!DB_URL);

suite("chat streaming pipeline (real route, real Postgres, stubbed runtime)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 4 });
  let alice: SessionUser;

  beforeAll(async () => {
    // Fail fast (rather than skip) if the URL points somewhere unmigrated.
    await db.select({ id: users.id }).from(users).limit(1);
  });

  beforeEach(async () => {
    await db.delete(users);
    const [row] = await db
      .insert(users)
      .values({
        pingSubject: "it-stream-alice",
        email: "stream-alice@example.com",
        displayName: "Alice",
        role: "user",
      })
      .returning();
    alice = {
      id: row!.id,
      email: row!.email,
      displayName: row!.displayName,
      role: row!.role,
    } as SessionUser;
    currentUser = alice;
    lastTurnInput = undefined;
    scriptedEvents = [];
  });

  afterAll(async () => {
    await db.delete(users);
  });

  it("streams an inline turn in order: meta, model, deltas, usage, persisted, done", async () => {
    scriptedEvents = [
      { type: "text-delta", delta: "Hello" },
      { type: "text-delta", delta: " world" },
      {
        type: "usage",
        tokensIn: 11,
        tokensOut: 7,
        inputTokens: 11,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
      { type: "done" },
    ];

    const res = await postChat({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const events = await collectSse(res);
    const types = events.map((e) => e.type);

    // The envelope always leads and an explicit terminal frame always closes.
    expect(types[0]).toBe("meta");
    expect(types.at(-1)).toBe("done");

    const meta = events[0] as Extract<ChatStreamEvent, { type: "meta" }>;
    expect(meta.runId).toBeTruthy();
    expect(meta.threadId).toBeTruthy();
    expect(meta.userMessageId).toBeTruthy();

    // Strict relative ordering of the load-bearing events.
    const order = types.filter((t) =>
      ["model", "text-delta", "usage", "done", "persisted"].includes(t),
    );
    expect(order).toEqual([
      "model",
      "text-delta",
      "text-delta",
      "usage",
      "persisted",
      "done",
    ]);

    const deltas = events
      .filter((e) => e.type === "text-delta")
      .map((e) => e.delta);
    expect(deltas).toEqual(["Hello", " world"]);
    const usage = events.find((e) => e.type === "usage")!;
    expect(usage).toMatchObject({ tokensIn: 11, tokensOut: 7 });

    // The stubbed runtime was asked the real question.
    expect(lastTurnInput?.threadId).toBe(meta.threadId);
    expect(
      lastTurnInput?.messages.some(
        (m) => m.role === "user" && m.content.includes("hi"),
      ),
    ).toBe(true);

    // Terminal persistence: run succeeded, assistant message stored.
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, meta.runId as string));
    expect(run?.status).toBe("succeeded");
    expect(run?.error).toBeNull();

    const persisted = events.find(
      (event): event is Extract<ChatStreamEvent, { type: "persisted" }> =>
        event.type === "persisted",
    )!;
    expect(events.at(-1)).toMatchObject({
      type: "done",
      stopReason: "completed",
    });
    const stored = await db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, meta.threadId as string))
      .orderBy(asc(chatMessages.createdAt));
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(stored[1]?.content).toBe("Hello world");
    expect(persisted.assistantMessageId).toBeTruthy();
  });

  it("surfaces a runtime error with a failed terminal, no success receipt, and a failed run", async () => {
    scriptedEvents = [
      { type: "text-delta", delta: "partial" },
      { type: "error", message: "provider exploded mid-turn" },
      { type: "done" },
    ];

    const res = await postChat({ message: "hi again" });
    const events = await collectSse(res);
    const types = events.map((e) => e.type);

    const errorEvent = events.find((e) => e.type === "error")!;
    expect(errorEvent.message).toContain("provider exploded mid-turn");
    // A failed turn must not claim success on the stream.
    expect(types).not.toContain("done");
    expect(types).not.toContain("persisted");
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      stopReason: "runtime_error",
      message: expect.stringContaining("provider exploded mid-turn"),
    });

    const meta = events[0] as Extract<ChatStreamEvent, { type: "meta" }>;
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, meta.runId as string));
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("provider exploded mid-turn");
  });

  it("routes durable work to the worker lane with an explicit queued terminal", async () => {
    const { startInProcessChatRunWorker } = await import("@/lib/chat-run-worker");

    const res = await postChat({
      message: "keep working on this in the background overnight",
    });
    const events = await collectSse(res);

    expect(events.map((e) => e.type)).toEqual(["meta", "queued", "done"]);
    const meta = events[0] as Extract<ChatStreamEvent, { type: "meta" }>;
    const queued = events[1] as Extract<ChatStreamEvent, { type: "queued" }>;
    expect(queued.runId).toBe(meta.runId);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "queued" });

    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, meta.runId as string));
    expect(run?.status).toBe("queued");
    expect(vi.mocked(startInProcessChatRunWorker)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: meta.runId }),
    );
    // The stubbed provider was never consulted on the request thread.
    expect(lastTurnInput).toBeUndefined();
  });

  it("fails and discards a partial answer when the provider stream ends without done", async () => {
    scriptedEvents = [{ type: "text-delta", delta: "partial answer" }];

    const res = await postChat({ message: "do not truncate this" });
    const events = await collectSse(res);
    const types = events.map((event) => event.type);

    expect(types).toContain("error");
    expect(types).not.toContain("persisted");
    expect(types).not.toContain("done");
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      stopReason: "runtime_error",
      message: expect.stringContaining("completion event"),
    });

    const meta = events[0] as Extract<ChatStreamEvent, { type: "meta" }>;
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, meta.runId));
    expect(run?.status).toBe("failed");

    const stored = await db
      .select({ role: chatMessages.role })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, meta.threadId))
      .orderBy(asc(chatMessages.createdAt));
    expect(stored.map((message) => message.role)).toEqual(["user"]);
  });

  it("rejects an unauthenticated caller before any streaming starts", async () => {
    currentUser = null;
    const res = await postChat({ message: "hi" });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
