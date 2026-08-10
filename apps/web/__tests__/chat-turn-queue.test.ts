import { describe, expect, it } from "vitest";
import {
  chatTurnQueueStorageKey,
  createQueuedChatTurn,
  editQueuedChatTurn,
  mergeQueuedChatTurns,
  moveQueuedChatTurn,
  moveQueuedChatTurnToFront,
  parseQueuedChatTurns,
} from "@/lib/chat-turn-queue";

const ids = {
  one: "11111111-1111-4111-8111-111111111111",
  two: "22222222-2222-4222-8222-222222222222",
  three: "33333333-3333-4333-8333-333333333333",
};

function turn(id: string, text: string, createdAt: string) {
  return createQueuedChatTurn({ text }, { id, createdAt });
}

describe("chat turn queue", () => {
  it("scopes transient and durable queues without crossing users", () => {
    expect(
      chatTurnQueueStorageKey({ userId: "user-1", tabId: "tab-1" }),
    ).toBe("comparative-chat-queue:v1:user-1:tab:tab-1");
    expect(
      chatTurnQueueStorageKey({
        userId: "user-1",
        tabId: "tab-1",
        threadId: "thread-1",
      }),
    ).toBe("comparative-chat-queue:v1:user-1:thread:thread-1");
    expect(chatTurnQueueStorageKey({ userId: "user-1" })).toBeNull();
  });

  it("restores interrupted sends as queued and drops malformed or duplicate rows", () => {
    const raw = JSON.stringify([
      { ...turn(ids.one, "First", "2026-08-10T10:00:00.000Z"), status: "sending" },
      turn(ids.one, "Duplicate", "2026-08-10T10:01:00.000Z"),
      { id: "not-a-uuid", text: "Invalid" },
      {
        ...turn(ids.two, "Second", "2026-08-10T10:02:00.000Z"),
        status: "failed",
        error: "Offline",
      },
    ]);

    expect(parseQueuedChatTurns(raw)).toEqual([
      turn(ids.one, "First", "2026-08-10T10:00:00.000Z"),
      {
        ...turn(ids.two, "Second", "2026-08-10T10:02:00.000Z"),
        status: "failed",
        error: "Offline",
      },
    ]);
    expect(parseQueuedChatTurns("not json")).toEqual([]);
  });

  it("keeps command metadata aligned with edits instead of sending stale context", () => {
    const skillTurn = createQueuedChatTurn(
      {
        text: "/weekly-status original notes",
        activatedSkill: {
          id: "skill-1",
          slug: "weekly-status",
          name: "Weekly status",
          args: "original notes",
          source: "explicit",
        },
      },
      { id: ids.one, createdAt: "2026-08-10T10:00:00.000Z" },
    );
    expect(
      editQueuedChatTurn(skillTurn, "/weekly-status revised notes")
        .activatedSkill?.args,
    ).toBe("revised notes");
    expect(editQueuedChatTurn(skillTurn, "Just send plain text")).not.toHaveProperty(
      "activatedSkill",
    );

    const modelTurn = createQueuedChatTurn(
      {
        text: "/model haiku Draft this",
        modelOverride: {
          mode: "model",
          modelId: "haiku-4-5",
          label: "haiku",
        },
      },
      { id: ids.two, createdAt: "2026-08-10T10:01:00.000Z" },
    );
    expect(
      editQueuedChatTurn(modelTurn, "/model sonnet Rewrite this").modelOverride,
    ).toMatchObject({ mode: "model", modelId: "sonnet-4-5" });
  });

  it("preserves selected context through queue persistence and edits", () => {
    const queued = createQueuedChatTurn(
      {
        text: "Summarize this",
        contextResources: [
          {
            reference: {
              version: 1,
              kind: "vault_item",
              resourceId: "memory-1",
            },
            label: "Quarterly priorities",
            description: "Approved memory",
            sourceLabel: "Vault",
          },
        ],
      },
      { id: ids.one, createdAt: "2026-08-10T10:00:00.000Z" },
    );

    const restored = parseQueuedChatTurns(JSON.stringify([queued]));
    expect(restored[0]?.contextResources).toEqual(queued.contextResources);
    expect(restored[0]?.contextResources?.[0]?.description).toBe("");
    expect(editQueuedChatTurn(restored[0]!, "Rewrite this")).toMatchObject({
      text: "Rewrite this",
      contextResources: queued.contextResources,
    });
  });

  it("edits, reorders, applies next, and merges persisted scopes deterministically", () => {
    const one = turn(ids.one, "One", "2026-08-10T10:00:00.000Z");
    const two = turn(ids.two, "Two", "2026-08-10T10:01:00.000Z");
    const three = turn(ids.three, "Three", "2026-08-10T10:02:00.000Z");

    expect(moveQueuedChatTurn([one, two, three], ids.three, -1)).toEqual([
      one,
      three,
      two,
    ]);
    expect(moveQueuedChatTurnToFront([one, two, three], ids.three)).toEqual([
      three,
      one,
      two,
    ]);
    expect(mergeQueuedChatTurns([three, two], [one, two])).toEqual([
      three,
      two,
      one,
    ]);
  });
});
