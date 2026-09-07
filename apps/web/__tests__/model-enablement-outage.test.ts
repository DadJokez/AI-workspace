import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@ai-workspace/db";

// Exercise the real gate without the temporary pin masking an outage.
vi.mock("@ai-workspace/agent", async (importOriginal) => ({
  ...await importOriginal<typeof import("@ai-workspace/agent")>(),
  PLATFORM_MODEL_OVERRIDE_ID: null,
  DEFAULT_MODEL_ID: "sonnet-4-6",
}));

import { DEFAULT_MODEL_ID, MODEL_IDS, MODEL_PURPOSES } from "@ai-workspace/agent";
import {
  enabledModelsForPurpose,
  invalidateModelEnablementCache,
  isModelEnabled,
  resolveModelCandidatesForPurpose,
  resolveModelForPurpose,
} from "@/lib/model-registry";
import { resolveRuntimeModelSelection } from "@/lib/runtime-model-policy";
import { parseModelCommand } from "@/lib/model-command";

function fakeDb() {
  const query = vi.fn<() => Promise<Array<{ modelId: string; purpose: string }>>>()
    .mockRejectedValue(new Error("synthetic database failure"));
  const chain = { from: () => chain, where: query };
  return { db: { select: () => chain } as unknown as Database, query };
}

beforeEach(() => { vi.spyOn(process.stderr, "write").mockReturnValue(true); });
afterEach(() => {
  invalidateModelEnablementCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("model enablement outage (#906)", () => {
  it("allows only the default across every purpose and every registered model", async () => {
    const { db, query } = fakeDb();
    for (const purpose of MODEL_PURPOSES) {
      expect(await enabledModelsForPurpose(db, purpose)).toEqual([DEFAULT_MODEL_ID]);
      for (const modelId of MODEL_IDS) {
        expect(await isModelEnabled(db, modelId, purpose)).toBe(modelId === DEFAULT_MODEL_ID);
      }
      expect(await resolveModelCandidatesForPurpose(db, purpose, { preferred: "nova-pro" }))
        .toEqual([DEFAULT_MODEL_ID]);
    }
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("refuses a disabled slash selection and serves the default for a stale explicit pin", async () => {
    const { db } = fakeDb();
    const enabled = await enabledModelsForPurpose(db, "chat");
    expect(parseModelCommand("/model nova-pro hello", enabled)).toBeNull();
    expect(await isModelEnabled(db, "nova-pro", "chat")).toBe(false);
    expect(await resolveModelForPurpose(db, "chat", { preferred: "nova-pro" })).toBe(DEFAULT_MODEL_ID);
    expect(resolveRuntimeModelSelection({
      requestedModelId: "nova-pro",
      forceRequestedModel: true,
      runtimeName: "bedrock",
      route: { runtimeTarget: "direct-chat" },
      enabledModelIds: new Set(enabled),
    }).modelId).toBe(DEFAULT_MODEL_ID);
  });

  it("reports every fallback but warns only once per purpose", async () => {
    const { db } = fakeDb();
    const onUnavailable = vi.fn();
    await enabledModelsForPurpose(db, "chat", { onUnavailable });
    await resolveModelCandidatesForPurpose(db, "chat", { onUnavailable, preferred: "nova-pro" });
    expect(onUnavailable).toHaveBeenCalledTimes(2);
    expect(onUnavailable).toHaveBeenLastCalledWith({
      reason: "model_enablement_unavailable",
      message: "Model enablement unavailable — using the default",
      purpose: "chat",
      modelId: DEFAULT_MODEL_ID,
    });
    expect(process.stderr.write).toHaveBeenCalledTimes(1);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('"purpose":"chat"'));
    expect(process.stderr.write).not.toHaveBeenCalledWith(expect.stringContaining("synthetic database failure"));
    await enabledModelsForPurpose(db, "routing");
    expect(process.stderr.write).toHaveBeenCalledTimes(2);
  });

  it("recovers after the cache TTL and logs a later outage anew", async () => {
    vi.useFakeTimers();
    const { db, query } = fakeDb();
    await enabledModelsForPurpose(db, "chat");
    query.mockResolvedValue([{ modelId: "nova-pro", purpose: "chat" }]);
    expect(await enabledModelsForPurpose(db, "chat")).toEqual([DEFAULT_MODEL_ID]);
    vi.advanceTimersByTime(30_001);
    const onUnavailable = vi.fn();
    expect(await enabledModelsForPurpose(db, "chat", { onUnavailable })).toEqual(["nova-pro"]);
    expect(onUnavailable).not.toHaveBeenCalled();
    query.mockRejectedValue(new Error("second outage"));
    vi.advanceTimersByTime(30_001);
    expect(await enabledModelsForPurpose(db, "chat")).toEqual([DEFAULT_MODEL_ID]);
    expect(process.stderr.write).toHaveBeenCalledTimes(2);
  });

  it("does not use stale enabled rows after their cache expires during an outage", async () => {
    vi.useFakeTimers();
    const { db, query } = fakeDb();
    query.mockResolvedValueOnce([{ modelId: "nova-pro", purpose: "chat" }]);
    expect(await isModelEnabled(db, "nova-pro", "chat")).toBe(true);
    vi.advanceTimersByTime(30_001);
    expect(await isModelEnabled(db, "nova-pro", "chat")).toBe(false);
    expect(await enabledModelsForPurpose(db, "chat")).toEqual([DEFAULT_MODEL_ID]);
  });

  it("keeps successful reads authoritative, including empty and purpose-specific sets", async () => {
    const { db, query } = fakeDb();
    query.mockResolvedValue([
      { modelId: "nova-pro", purpose: "routing" },
      { modelId: "unknown-model", purpose: "chat" },
    ]);
    const onUnavailable = vi.fn();
    expect(await enabledModelsForPurpose(db, "routing", { onUnavailable })).toEqual(["nova-pro"]);
    expect(await enabledModelsForPurpose(db, "chat", { onUnavailable })).toEqual([]);
    expect(await isModelEnabled(db, DEFAULT_MODEL_ID, "chat")).toBe(false);
    await expect(resolveModelForPurpose(db, "chat")).rejects.toThrow("No models are enabled");
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(process.stderr.write).not.toHaveBeenCalled();
  });
});
