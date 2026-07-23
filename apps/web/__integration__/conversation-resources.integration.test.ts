import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chatThreads,
  createDb,
  runs,
  users,
} from "@ai-workspace/db";

import {
  loadPreviousConversationResourceResolution,
  type ConversationResourceResolution,
} from "@/lib/conversation-resources";

const DB_URL = process.env.DATABASE_URL;

if (!DB_URL && process.env.CI) {
  throw new Error(
    "conversation resource integration suite: DATABASE_URL is empty in CI.",
  );
}

const suite = describe.skipIf(!DB_URL);

suite("durable conversation resource selection (real Postgres)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 2 });

  beforeAll(async () => {
    await db.select({ id: users.id }).from(users).limit(1);
  });

  afterAll(async () => {
    await db.delete(users);
  });

  it("loads the latest selected receipt across newer unrelated runs", async () => {
    await db.delete(users);
    const [owner, other] = await db
      .insert(users)
      .values([
        {
          pingSubject: "resource-owner",
          email: "resource-owner@example.com",
          displayName: "Resource Owner",
          role: "user",
        },
        {
          pingSubject: "resource-other",
          email: "resource-other@example.com",
          displayName: "Other User",
          role: "user",
        },
      ])
      .returning();
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId: owner!.id,
        title: "Durable resources",
        defaultModelId: "sonnet-4-6",
      })
      .returning();
    const selected = selectedResolution("resource-orders", "orders.csv");
    const baseTime = new Date("2026-07-23T12:00:00.000Z");

    await db.insert(runs).values([
      {
        userId: owner!.id,
        threadId: thread!.id,
        skillSlug: "chat-turn",
        status: "succeeded",
        inputs: { resourceResolution: selected },
        createdAt: baseTime,
        updatedAt: baseTime,
      },
      {
        userId: owner!.id,
        threadId: thread!.id,
        skillSlug: "chat-turn",
        status: "succeeded",
        inputs: {
          resourceResolution: {
            version: 1,
            status: "none",
            intent: false,
            selected: [],
            candidates: [],
            requiresCompleteFileTool: false,
          },
        },
        createdAt: new Date(baseTime.getTime() + 1_000),
        updatedAt: new Date(baseTime.getTime() + 1_000),
      },
      {
        userId: other!.id,
        threadId: thread!.id,
        skillSlug: "chat-turn",
        status: "succeeded",
        inputs: {
          resourceResolution: selectedResolution(
            "resource-other",
            "other.csv",
          ),
        },
        createdAt: new Date(baseTime.getTime() + 2_000),
        updatedAt: new Date(baseTime.getTime() + 2_000),
      },
    ]);

    await expect(
      loadPreviousConversationResourceResolution({
        db,
        userId: owner!.id,
        threadId: thread!.id,
      }),
    ).resolves.toEqual(selected);
  });
});

function selectedResolution(
  resourceId: string,
  filename: string,
): ConversationResourceResolution {
  return {
    version: 1,
    status: "selected",
    intent: true,
    selected: [
      {
        resourceId,
        filename,
        mimeType: "text/csv",
        kind: "spreadsheet",
        sizeBytes: 42,
        representation: "tabular_dataset",
        coverage: "full",
        reason: "current_upload",
      },
    ],
    candidates: [{ resourceId, filename, kind: "spreadsheet" }],
    requiresCompleteFileTool: true,
  };
}
