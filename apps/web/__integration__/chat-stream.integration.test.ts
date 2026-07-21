import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@ai-workspace/agent";
import type { SessionUser } from "@ai-workspace/auth";
import { chatMessages, createDb, runs, users } from "@ai-workspace/db";
import { asc, eq } from "drizzle-orm";
import { readSseStream } from "@/lib/sse";

/**
 * The chat streaming spine, proven end-to-end at the cheapest layer that is
 * still real: the REAL /api/chat POST handler against real Postgres, with
 * ONLY the model/runtime seam stubbed (`getRuntime` — the same seam both
 * runtime lanes share). Events come back through `readSseStream` itself, so
 * the server's SSE framing and the client parser are exercised as one pipe.
 *
 * Covered: inline event ordering (meta -> model -> deltas -> usage -> done ->
 * persisted), terminal persistence (assistant message + run status), the
 * runtime-error path (error event, no done/persisted, run failed), and the
 * durable lane's queued terminal event.
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

interface SseEvent {
  type: string;
  [key: string]: unknown;
}

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

async function collectSse(res: Response): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of readSseStream<SseEvent>(res)) events.push(event);
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

  it("streams an inline turn in order: meta, model, deltas, usage, done, persisted", async () => {
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

    // The envelope always leads and the persistence receipt always closes.
    expect(types[0]).toBe("meta");
    expect(types.at(-1)).toBe("persisted");

    const meta = events[0]!;
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
      "done",
      "persisted",
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

    const persisted = events.at(-1)!;
    const stored = await db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, meta.threadId as string))
      .orderBy(asc(chatMessages.createdAt));
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(stored[1]?.content).toBe("Hello world");
    expect(persisted.assistantMessageId).toBeTruthy();
  });

  it("surfaces a runtime error as an error event, with no done/persisted, and fails the run", async () => {
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

    const meta = events[0]!;
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, meta.runId as string));
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("provider exploded mid-turn");
  });

  it("routes durable work to the worker lane: meta then queued as the terminal event", async () => {
    const { startInProcessChatRunWorker } = await import("@/lib/chat-run-worker");

    const res = await postChat({
      message: "keep working on this in the background overnight",
    });
    const events = await collectSse(res);

    expect(events.map((e) => e.type)).toEqual(["meta", "queued"]);
    const meta = events[0]!;
    const queued = events[1]!;
    expect(queued.runId).toBe(meta.runId);

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

  it("rejects an unauthenticated caller before any streaming starts", async () => {
    currentUser = null;
    const res = await postChat({ message: "hi" });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
