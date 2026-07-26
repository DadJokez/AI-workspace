import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "@ai-workspace/db";
import {
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  MODELS,
  estimateCostUsd,
} from "@ai-workspace/agent";
import {
  enabledModelsForPurpose,
  invalidateModelEnablementCache,
  isModelEnabled,
  orderModelCandidatesForPurpose,
  resolveModelCandidatesForPurpose,
  resolveModelForPurpose,
} from "@/lib/model-registry";

/**
 * The account-wide platform pin decides every enablement answer below, so these
 * assertions track `DEFAULT_MODEL_ID` instead of naming a model version — moving
 * the pin stays a one-line change in `packages/agent/src/models.ts`.
 */
const UNPINNED_MODEL_IDS = MODEL_IDS.filter((id) => id !== DEFAULT_MODEL_ID);

function fakeDb(
  rows: Array<{ modelId: string; purpose: string }> | Error,
): Database {
  const chain = {
    from: () => chain,
    where: () => {
      if (rows instanceof Error) return Promise.reject(rows);
      return Promise.resolve(rows);
    },
  };
  return { select: () => chain } as unknown as Database;
}

afterEach(() => {
  invalidateModelEnablementCache();
});

describe("enabledModelsForPurpose", () => {
  it("returns only the pinned platform model for every purpose", async () => {
    const db = fakeDb(
      UNPINNED_MODEL_IDS.flatMap((modelId) => [
        { modelId, purpose: "chat" },
        { modelId, purpose: "memory-capture" },
      ]),
    );

    expect(await enabledModelsForPurpose(db, "chat")).toEqual([
      DEFAULT_MODEL_ID,
    ]);
    expect(await enabledModelsForPurpose(db, "memory-capture")).toEqual([
      DEFAULT_MODEL_ID,
    ]);
    expect(await enabledModelsForPurpose(db, "durable-local")).toEqual([
      DEFAULT_MODEL_ID,
    ]);
  });
});

describe("isModelEnabled", () => {
  it("only reports the platform override as enabled", async () => {
    const db = fakeDb(
      UNPINNED_MODEL_IDS.map((modelId) => ({ modelId, purpose: "chat" })),
    );

    expect(await isModelEnabled(db, DEFAULT_MODEL_ID, "chat")).toBe(true);
    for (const modelId of UNPINNED_MODEL_IDS) {
      expect(await isModelEnabled(db, modelId, "chat")).toBe(false);
    }
    expect(await isModelEnabled(db, "gpt-troll", "chat")).toBe(false);
  });
});

describe("resolveModelForPurpose", () => {
  it("supersedes persisted preferences for every internal purpose", async () => {
    const db = fakeDb(
      UNPINNED_MODEL_IDS.map((modelId) => ({
        modelId,
        purpose: "memory-capture",
      })),
    );

    expect(
      await resolveModelForPurpose(db, "memory-capture", {
        preferred: UNPINNED_MODEL_IDS[0],
      }),
    ).toBe(DEFAULT_MODEL_ID);
    expect(
      await resolveModelForPurpose(db, "summaries", {
        preferred: UNPINNED_MODEL_IDS.at(-1),
      }),
    ).toBe(DEFAULT_MODEL_ID);
    expect(await resolveModelForPurpose(db, "routing")).toBe(DEFAULT_MODEL_ID);
  });
});

describe("model candidate ordering", () => {
  it("orders user-facing fallback by policy after the selected primary", () => {
    expect(
      orderModelCandidatesForPurpose(
        "chat",
        ["haiku-4-5", "sonnet-4-6", "opus-4-7"],
        "sonnet-4-6",
      ),
    ).toEqual(["sonnet-4-6", "opus-4-7", "haiku-4-5"]);
  });

  it("keeps an explicit enabled primary first without introducing disabled models", () => {
    expect(
      orderModelCandidatesForPurpose(
        "chat",
        ["haiku-4-5", "sonnet-4-6"],
        "haiku-4-5",
      ),
    ).toEqual(["haiku-4-5", "sonnet-4-6"]);
  });

  it("never manufactures a fallback when the enablement set is empty", () => {
    expect(() =>
      orderModelCandidatesForPurpose("chat", [], "sonnet-4-6"),
    ).toThrow('No models are enabled for purpose "chat".');
  });

  it("pins internal candidate lists to the pinned platform model", async () => {
    const db = fakeDb(
      UNPINNED_MODEL_IDS.map((modelId) => ({ modelId, purpose: "routing" })),
    );

    expect(await resolveModelCandidatesForPurpose(db, "routing")).toEqual([
      DEFAULT_MODEL_ID,
    ]);
  });
});

describe("cache", () => {
  it("bypasses the enablement table while the platform pin is active", async () => {
    let calls = 0;
    const chain = {
      from: () => chain,
      where: () => {
        calls += 1;
        return Promise.resolve([{ modelId: "sonnet-4-6", purpose: "chat" }]);
      },
    };
    const db = { select: () => chain } as unknown as Database;

    await enabledModelsForPurpose(db, "chat");
    await enabledModelsForPurpose(db, "chat");
    expect(calls).toBe(0);

    invalidateModelEnablementCache();
    await enabledModelsForPurpose(db, "chat");
    expect(calls).toBe(0);
  });
});

describe("cost metadata", () => {
  it("matches the us.* geo cross-region inference-profile rates (list + 10%, July 2026)", () => {
    // Not global-endpoint list prices — see the note above MODELS in
    // packages/agent/src/models.ts. Router-lane selection (#303) reads these;
    // don't "fix" them back to list.
    expect(MODELS["haiku-4-5"].costPer1MInput).toBe(1.1);
    expect(MODELS["haiku-4-5"].costPer1MOutput).toBe(5.5);
    expect(MODELS["sonnet-4-5"].costPer1MInput).toBe(3.3);
    expect(MODELS["sonnet-4-5"].costPer1MOutput).toBe(16.5);
    expect(MODELS["sonnet-4-6"].costPer1MInput).toBe(3.3);
    expect(MODELS["sonnet-4-6"].costPer1MOutput).toBe(16.5);
    expect(MODELS["opus-4-7"].costPer1MInput).toBe(5.5);
    expect(MODELS["opus-4-7"].costPer1MOutput).toBe(27.5);
  });

  it("estimateCostUsd combines input and output rates", () => {
    expect(estimateCostUsd("haiku-4-5", 1_000_000, 1_000_000)).toBeCloseTo(6.6);
    expect(estimateCostUsd("sonnet-4-5", 500_000, 100_000)).toBeCloseTo(3.3);
    expect(estimateCostUsd("sonnet-4-6", 500_000, 100_000)).toBeCloseTo(3.3);
  });
});
