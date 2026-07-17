import { describe, expect, it, vi } from "vitest";
import type { Database } from "@ai-workspace/db";
import { ensureThreadActivation } from "@/lib/thread-activation";

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
