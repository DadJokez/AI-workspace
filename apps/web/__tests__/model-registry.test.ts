import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "@ai-workspace/db";
import { MODELS, estimateCostUsd } from "@ai-workspace/agent";
import {
  enabledModelsForPurpose,
  invalidateModelEnablementCache,
  isModelEnabled,
  orderModelCandidatesForPurpose,
  resolveModelCandidatesForPurpose,
  resolveModelForPurpose,
} from "@/lib/model-registry";

/** Temporary platform override while the Sonnet 4.6 quota is unavailable. */

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
  it("returns only Sonnet 4.5 for every purpose", async () => {
    const db = fakeDb([
      { modelId: "haiku-4-5", purpose: "chat" },
      { modelId: "sonnet-4-6", purpose: "chat" },
      { modelId: "sonnet-4-6", purpose: "memory-capture" },
    ]);

    expect(await enabledModelsForPurpose(db, "chat")).toEqual(["sonnet-4-5"]);
    expect(await enabledModelsForPurpose(db, "memory-capture")).toEqual([
      "sonnet-4-5",
    ]);
    expect(await enabledModelsForPurpose(db, "durable-local")).toEqual([
      "sonnet-4-5",
    ]);
  });
});

describe("isModelEnabled", () => {
  it("only reports the platform override as enabled", async () => {
    const db = fakeDb([{ modelId: "sonnet-4-6", purpose: "chat" }]);

    expect(await isModelEnabled(db, "sonnet-4-5", "chat")).toBe(true);
    expect(await isModelEnabled(db, "sonnet-4-6", "chat")).toBe(false);
    expect(await isModelEnabled(db, "opus-4-7", "chat")).toBe(false);
    expect(await isModelEnabled(db, "gpt-troll", "chat")).toBe(false);
  });
});

describe("resolveModelForPurpose", () => {
  it("supersedes persisted preferences for every internal purpose", async () => {
    const db = fakeDb([
      { modelId: "haiku-4-5", purpose: "memory-capture" },
      { modelId: "sonnet-4-6", purpose: "memory-capture" },
    ]);

    expect(
      await resolveModelForPurpose(db, "memory-capture", {
        preferred: "haiku-4-5",
      }),
    ).toBe("sonnet-4-5");
    expect(
      await resolveModelForPurpose(db, "summaries", {
        preferred: "opus-4-7",
      }),
    ).toBe("sonnet-4-5");
    expect(await resolveModelForPurpose(db, "routing")).toBe("sonnet-4-5");
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

  it("pins internal candidate lists to Sonnet 4.5", async () => {
    const db = fakeDb([
      { modelId: "haiku-4-5", purpose: "routing" },
      { modelId: "sonnet-4-6", purpose: "routing" },
      { modelId: "opus-4-7", purpose: "routing" },
    ]);

    expect(await resolveModelCandidatesForPurpose(db, "routing")).toEqual([
      "sonnet-4-5",
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
