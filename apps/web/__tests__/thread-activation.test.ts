import { describe, expect, it, vi } from "vitest";
import type { Database } from "@ai-workspace/db";
import type { AgentEvent } from "@ai-workspace/agent";
import {
  ensureThreadActivation,
  persistActivationFromEvent,
} from "@/lib/thread-activation";

/**
 * #384 P1 — thread-sticky activation over chat_threads.mcp_signature.
 * Activation only ever grows; unchanged sets must not touch the database
 * (the write would bump updatedAt on every turn for nothing).
 */
function mockDb() {
  const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
  const update = vi.fn().mockReturnValue({ set });
  return { db: { update } as unknown as Database, update, set };
}

describe("ensureThreadActivation", () => {
  it("unions granted providers into an empty signature and persists", async () => {
    const { db, update, set } = mockDb();
    const activated = await ensureThreadActivation(
      db,
      { id: "t1", mcpSignature: null },
      ["notion", "github"],
    );
    expect(activated).toEqual(["github", "notion"]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ mcpSignature: "github,notion" }),
    );
  });

  it("adds new providers to an existing activation (sticky, additive)", async () => {
    const { db, set } = mockDb();
    const activated = await ensureThreadActivation(
      db,
      { id: "t1", mcpSignature: "github" },
      ["salesforce"],
    );
    expect(activated).toEqual(["github", "salesforce"]);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ mcpSignature: "github,salesforce" }),
    );
  });

  it("never removes providers and skips the write when nothing changed", async () => {
    const { db, update } = mockDb();
    const activated = await ensureThreadActivation(
      db,
      { id: "t1", mcpSignature: "github,notion" },
      ["github"],
    );
    expect(activated).toEqual(["github", "notion"]);
    expect(update).not.toHaveBeenCalled();
  });

  it("treats granted-provider order and duplicates as irrelevant", async () => {
    const { db, update } = mockDb();
    const activated = await ensureThreadActivation(
      db,
      { id: "t1", mcpSignature: "github,notion" },
      ["notion", "github", "notion"],
    );
    expect(activated).toEqual(["github", "notion"]);
    expect(update).not.toHaveBeenCalled();
  });
});

/**
 * #384 P2 — the sticky-activation persistence trigger shared by both
 * runtime lanes. Drives synthetic activate tool-call events through the
 * one place provider extraction, granting guard, signature threading, and
 * best-effort failure live (previously copy-pasted into both runners).
 */
function activateEvent(provider: unknown): AgentEvent {
  return {
    type: "tool-call",
    call: {
      id: "call-1",
      name: "comparative__activate_tools",
      input: { provider } as Record<string, unknown>,
    },
  } as AgentEvent;
}

describe("persistActivationFromEvent", () => {
  it("persists a granted provider from an activate tool-call", async () => {
    const { db, set } = mockDb();
    const next = await persistActivationFromEvent({
      db,
      threadId: "t1",
      grantedProviders: ["github", "google"],
      event: activateEvent("github"),
      currentSignature: "google",
    });
    expect(next).toBe("github,google");
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ mcpSignature: "github,google" }),
    );
  });

  it("ignores non-activate events and non-granted or garbage providers", async () => {
    const { db, update } = mockDb();
    const base = { db, threadId: "t1", grantedProviders: ["github"], currentSignature: "github" };
    // A non-activate tool-call.
    expect(
      await persistActivationFromEvent({
        ...base,
        event: { type: "tool-call", call: { id: "c", name: "github__list_prs", input: {} } } as AgentEvent,
      }),
    ).toBe("github");
    // A non-tool-call event.
    expect(
      await persistActivationFromEvent({
        ...base,
        event: { type: "text-delta", delta: "hi" } as AgentEvent,
      }),
    ).toBe("github");
    // A provider that isn't granted.
    expect(
      await persistActivationFromEvent({ ...base, event: activateEvent("salesforce") }),
    ).toBe("github");
    // Garbage input.
    expect(
      await persistActivationFromEvent({ ...base, event: activateEvent(42) }),
    ).toBe("github");
    expect(update).not.toHaveBeenCalled();
  });

  it("normalizes casing/whitespace before the granted check", async () => {
    const { db, set } = mockDb();
    const next = await persistActivationFromEvent({
      db,
      threadId: "t1",
      grantedProviders: ["github"],
      event: activateEvent("  GitHub  "),
      currentSignature: "",
    });
    expect(next).toBe("github");
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ mcpSignature: "github" }),
    );
  });

  it("threads the signature so two same-turn activations don't union a stale snapshot", async () => {
    const { db } = mockDb();
    let sig = "";
    sig = await persistActivationFromEvent({
      db, threadId: "t1", grantedProviders: ["github", "notion"],
      event: activateEvent("github"), currentSignature: sig,
    });
    sig = await persistActivationFromEvent({
      db, threadId: "t1", grantedProviders: ["github", "notion"],
      event: activateEvent("notion"), currentSignature: sig,
    });
    // Second activation unions onto the first's result, not the empty start.
    expect(sig).toBe("github,notion");
  });

  it("swallows a failing db and never throws (best-effort)", async () => {
    const db = {
      update: () => {
        throw new Error("db unavailable");
      },
    } as unknown as Database;
    const next = await persistActivationFromEvent({
      db,
      threadId: "t1",
      grantedProviders: ["github"],
      event: activateEvent("github"),
      currentSignature: "existing",
    });
    // Returns the prior signature unchanged; next turn re-derives.
    expect(next).toBe("existing");
  });
});
