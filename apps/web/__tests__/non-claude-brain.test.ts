import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@ai-workspace/db";

// #797 P3: these contracts must hold once the temporary platform pin is
// lifted — with the pin active every lookup collapses to the pinned model and
// the tests below would pass vacuously. Only the pin (and the default that is
// derived from it) is replaced; the registry and enablement code are real.
vi.mock("@ai-workspace/agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@ai-workspace/agent")>();
  return { ...actual, PLATFORM_MODEL_OVERRIDE_ID: null, DEFAULT_MODEL_ID: "sonnet-4-6" };
});

import {
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  MODEL_PURPOSES,
  MODELS,
  PLATFORM_MODEL_OVERRIDE_ID,
  type ModelId,
} from "@ai-workspace/agent";
import {
  enabledModelsForPurpose,
  invalidateModelEnablementCache,
  isModelEnabled,
  orderModelCandidatesForPurpose,
  resolveModelForPurpose,
} from "@/lib/model-registry";
import { resolveRuntimeModelSelection } from "@/lib/runtime-model-policy";

/** The rows migration 0031 seeds: the three Claude tiers for every purpose. */
const SEEDED: ModelId[] = ["haiku-4-5", "sonnet-4-6", "opus-4-7"];

function seededRows(extra: Array<{ modelId: string; purpose: string }> = []) {
  return [
    ...SEEDED.flatMap((modelId) =>
      MODEL_PURPOSES.map((purpose) => ({ modelId, purpose })),
    ),
    ...extra,
  ];
}

function fakeDb(rows: Array<{ modelId: string; purpose: string }>): Database {
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(rows),
  };
  return { select: () => chain } as unknown as Database;
}

const directRoute = { runtimeTarget: "direct-chat" as const };

afterEach(() => {
  invalidateModelEnablementCache();
});

describe("nova-pro is registered but disabled by default (#797 P3)", () => {
  it("is a real registry entry that neither the default nor the platform pin points at", () => {
    expect(PLATFORM_MODEL_OVERRIDE_ID).toBeNull();
    expect(MODEL_IDS).toContain("nova-pro");
    expect(DEFAULT_MODEL_ID).not.toBe("nova-pro");
    expect(MODELS["nova-pro"]).toMatchObject({
      provider: "amazon",
      invocation: "converse",
      supportsPromptCaching: false,
    });
  });

  it("is enabled for no purpose without a model_enablement row", async () => {
    const db = fakeDb(seededRows());
    for (const purpose of MODEL_PURPOSES) {
      expect(await isModelEnabled(db, "nova-pro", purpose)).toBe(false);
      expect(await enabledModelsForPurpose(db, purpose)).not.toContain(
        "nova-pro",
      );
    }
  });

  it("cannot be selected for a turn without a row, even when explicitly requested by id or Bedrock id", () => {
    for (const requestedModelId of ["nova-pro", MODELS["nova-pro"].bedrockModelId]) {
      const selection = resolveRuntimeModelSelection({
        requestedModelId,
        route: directRoute,
        runtimeName: "bedrock",
        directModelId: undefined,
        forceRequestedModel: true,
        enabledModelIds: new Set(SEEDED),
      });
      expect(selection.modelId).not.toBe("nova-pro");
      expect(selection.reason).toBe("default_model_fallback");
    }
  });

  it("is selectable by registry id or Bedrock id once a chat row exists", () => {
    for (const requestedModelId of ["nova-pro", MODELS["nova-pro"].bedrockModelId]) {
      expect(
        resolveRuntimeModelSelection({
          requestedModelId,
          route: directRoute,
          runtimeName: "bedrock",
          directModelId: undefined,
          forceRequestedModel: true,
          enabledModelIds: new Set([...SEEDED, "nova-pro"]),
        }),
      ).toMatchObject({
        modelId: "nova-pro",
        providerModelId: "us.amazon.nova-pro-v1:0",
      });
    }
  });

  it("keeps summaries, routing and memory-capture on Claude even when nova-pro is the chat brain", async () => {
    // Internal consumers resolve via resolveModelForPurpose against their own
    // purpose rows; enabling the chat brain never silently swaps them.
    const db = fakeDb(seededRows([{ modelId: "nova-pro", purpose: "chat" }]));
    expect(await enabledModelsForPurpose(db, "chat")).toContain("nova-pro");
    for (const purpose of ["summaries", "routing", "memory-capture"] as const) {
      const resolved = await resolveModelForPurpose(db, purpose, {
        preferred: "nova-pro",
      });
      expect(MODELS[resolved].provider).toBe("anthropic");
    }
  });
});

describe("cross-provider failover chains (#797 P3)", () => {
  it("leaves the Claude-only chain exactly as before", () => {
    expect(
      orderModelCandidatesForPurpose("chat", SEEDED, "sonnet-4-6"),
    ).toEqual(["sonnet-4-6", "opus-4-7", "haiku-4-5"]);
  });

  it("never manufactures a hop into nova-pro without its row", () => {
    expect(
      orderModelCandidatesForPurpose("chat", SEEDED, "nova-pro"),
    ).toEqual(["sonnet-4-6", "opus-4-7", "haiku-4-5"]);
  });

  it("adds nova-pro as the last (cheapest) hop once it is enabled for the purpose", () => {
    expect(
      orderModelCandidatesForPurpose(
        "chat",
        [...SEEDED, "nova-pro"],
        "sonnet-4-6",
      ),
    ).toEqual(["sonnet-4-6", "opus-4-7", "haiku-4-5", "nova-pro"]);
  });
});
