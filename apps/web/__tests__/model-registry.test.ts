import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "@ai-workspace/db";
import {
  enabledModelsForPurpose,
  invalidateModelEnablementCache,
  isModelEnabled,
  resolveModelForPurpose,
} from "@/lib/model-registry";

/**
 * Enablement resolution (#300). Absence of a row = disabled, so a newly
 * registered model is disabled everywhere until explicitly enabled.
 */

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
  it("returns only the models with an enabled row for the purpose", async () => {
    const db = fakeDb([
      { modelId: "haiku-4-5", purpose: "chat" },
      { modelId: "sonnet-4-6", purpose: "chat" },
      { modelId: "sonnet-4-6", purpose: "memory-capture" },
    ]);

    expect(await enabledModelsForPurpose(db, "chat")).toEqual([
      "haiku-4-5",
      "sonnet-4-6",
    ]);
    expect(await enabledModelsForPurpose(db, "memory-capture")).toEqual([
      "sonnet-4-6",
    ]);
  });

  it("a purpose with no rows has nothing enabled (disabled-everywhere default)", async () => {
    const db = fakeDb([{ modelId: "sonnet-4-6", purpose: "chat" }]);

    expect(await enabledModelsForPurpose(db, "durable-local")).toEqual([]);
  });

  it("ignores enablement rows for ids the registry does not know", async () => {
    const db = fakeDb([{ modelId: "nova-micro-1", purpose: "chat" }]);

    expect(await enabledModelsForPurpose(db, "chat")).toEqual([]);
  });

  it("fails open to the full registry when the table is unreachable", async () => {
    const db = fakeDb(new Error("relation model_enablement does not exist"));

    expect(await enabledModelsForPurpose(db, "chat")).toEqual([
      "haiku-4-5",
      "sonnet-4-6",
      "opus-4-7",
    ]);
  });
});

describe("isModelEnabled", () => {
  it("is false for a registered model without a row and for unknown ids", async () => {
    const db = fakeDb([{ modelId: "sonnet-4-6", purpose: "chat" }]);

    expect(await isModelEnabled(db, "sonnet-4-6", "chat")).toBe(true);
    expect(await isModelEnabled(db, "opus-4-7", "chat")).toBe(false);
    expect(await isModelEnabled(db, "gpt-troll", "chat")).toBe(false);
  });
});

describe("resolveModelForPurpose", () => {
  it("honors an enabled preferred model", async () => {
    const db = fakeDb([
      { modelId: "haiku-4-5", purpose: "memory-capture" },
      { modelId: "sonnet-4-6", purpose: "memory-capture" },
    ]);

    expect(
      await resolveModelForPurpose(db, "memory-capture", {
        preferred: "haiku-4-5",
      }),
    ).toBe("haiku-4-5");
  });

  it("never returns a disabled preferred model", async () => {
    const db = fakeDb([{ modelId: "sonnet-4-6", purpose: "memory-capture" }]);

    expect(
      await resolveModelForPurpose(db, "memory-capture", {
        preferred: "opus-4-7",
      }),
    ).toBe("sonnet-4-6");
  });

  it("falls to the first enabled model when the default is disabled", async () => {
    const db = fakeDb([{ modelId: "haiku-4-5", purpose: "summaries" }]);

    expect(await resolveModelForPurpose(db, "summaries")).toBe("haiku-4-5");
  });

  it("falls back to the app default when nothing is enabled (misconfig)", async () => {
    const db = fakeDb([]);

    expect(await resolveModelForPurpose(db, "routing")).toBe("sonnet-4-6");
  });
});

describe("cache", () => {
  it("caches between calls and refreshes after invalidation", async () => {
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
    expect(calls).toBe(1);

    invalidateModelEnablementCache();
    await enabledModelsForPurpose(db, "chat");
    expect(calls).toBe(2);
  });
});
