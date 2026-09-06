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

describe("the GPT-5.6 entries are registered but disabled by default (#660 / #797 P4)", () => {
  const GPT: ModelId[] = ["gpt-5-6-terra", "gpt-5-6-sol", "gpt-5-6-luna"];

  it("are responses-route registry entries that neither the default nor the platform pin points at", () => {
    for (const id of GPT) {
      expect(MODEL_IDS).toContain(id);
      expect(DEFAULT_MODEL_ID).not.toBe(id);
      expect(MODELS[id]).toMatchObject({
        provider: "openai",
        providerDisplayName: "OpenAI",
        invocation: "responses",
        supportsPromptCaching: false,
      });
      expect(MODELS[id].bedrockModelId).toMatch(/^us\.openai\.gpt-5\.6-/);
    }
  });

  it("are enabled for no purpose without a model_enablement row", async () => {
    const db = fakeDb(seededRows());
    for (const purpose of MODEL_PURPOSES) {
      const enabled = await enabledModelsForPurpose(db, purpose);
      for (const id of GPT) {
        expect(await isModelEnabled(db, id, purpose)).toBe(false);
        expect(enabled).not.toContain(id);
      }
    }
  });

  it("cannot be selected for a turn without a row, even when explicitly requested by id or Bedrock id", () => {
    for (const requestedModelId of ["gpt-5-6-terra", MODELS["gpt-5-6-terra"].bedrockModelId]) {
      const selection = resolveRuntimeModelSelection({
        requestedModelId,
        route: directRoute,
        runtimeName: "bedrock",
        directModelId: undefined,
        forceRequestedModel: true,
        enabledModelIds: new Set(SEEDED),
      });
      expect(selection.modelId).not.toBe("gpt-5-6-terra");
      expect(selection.reason).toBe("default_model_fallback");
    }
  });

  it("keeps summaries, routing and memory-capture on Claude even when Terra is the chat brain", async () => {
    const db = fakeDb(seededRows([{ modelId: "gpt-5-6-terra", purpose: "chat" }]));
    expect(await enabledModelsForPurpose(db, "chat")).toContain("gpt-5-6-terra");
    for (const purpose of ["summaries", "routing", "memory-capture"] as const) {
      const resolved = await resolveModelForPurpose(db, purpose, {
        preferred: "gpt-5-6-terra",
      });
      expect(MODELS[resolved].provider).toBe("anthropic");
    }
  });
});

/** The 2026-09-06 gaggle (#797 P5): registered for qualification, no rows. */
const GAGGLE: ModelId[] = [
  "qwen3-32b",
  "qwen3-next-80b",
  "kimi-k2-5",
  "glm-4-7",
  "glm-5",
  "nemotron-super-3-120b",
  "deepseek-v3-2",
  "sonnet-5",
  "opus-5",
  "fable-5-1",
];

describe("the 2026-09-06 gaggle is registered but disabled by default (#797 P5)", () => {
  it.each(GAGGLE)(
    "%s: registered, not the default, disabled for every purpose without a row, unselectable by id or Bedrock id",
    async (id) => {
      expect(MODEL_IDS).toContain(id);
      expect(DEFAULT_MODEL_ID).not.toBe(id);
      expect(MODELS[id].invocation).toBe("converse");
      // Only Anthropic entries are in Bedrock's explicit `cachePoint` table;
      // every other vendor's entry must say so or its requests are rejected.
      expect(MODELS[id].supportsPromptCaching).toBe(
        MODELS[id].provider === "anthropic",
      );
      const db = fakeDb(seededRows());
      for (const purpose of MODEL_PURPOSES) {
        expect(await isModelEnabled(db, id, purpose)).toBe(false);
        expect(await enabledModelsForPurpose(db, purpose)).not.toContain(id);
      }
      for (const requestedModelId of [id, MODELS[id].bedrockModelId]) {
        const selection = resolveRuntimeModelSelection({
          requestedModelId,
          route: directRoute,
          runtimeName: "bedrock",
          directModelId: undefined,
          forceRequestedModel: true,
          enabledModelIds: new Set(SEEDED),
        });
        expect(selection.modelId).not.toBe(id);
        expect(selection.reason).toBe("default_model_fallback");
      }
    },
  );

  it("leaves every seeded failover chain byte-identical with ten more entries registered", () => {
    expect(
      orderModelCandidatesForPurpose("chat", SEEDED, "sonnet-4-6"),
    ).toEqual(["sonnet-4-6", "opus-4-7", "haiku-4-5"]);
    for (const purpose of MODEL_PURPOSES) {
      for (const id of orderModelCandidatesForPurpose(purpose, SEEDED, "sonnet-4-6")) {
        expect(SEEDED).toContain(id);
      }
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

describe("gpt-oss-120b is registered but disabled by default (#797)", () => {
  it("is a real registry entry that neither the default nor the platform pin points at", () => {
    expect(MODEL_IDS).toContain("gpt-oss-120b");
    // Registered right after the GPT-5.6 trio (#917); the 2026-09-06 gaggle
    // (#919) is registered after it, so the registry's last entry is Fable 5.1.
    expect(MODEL_IDS.indexOf("gpt-oss-120b")).toBe(
      MODEL_IDS.indexOf("gpt-5-6-luna") + 1,
    );
    expect(MODEL_IDS.at(-1)).toBe("fable-5-1");
    expect(DEFAULT_MODEL_ID).not.toBe("gpt-oss-120b");
    expect(MODELS["gpt-oss-120b"]).toMatchObject({
      // ON_DEMAND only — no `us.` inference profile exists for this model.
      bedrockModelId: "openai.gpt-oss-120b-1:0",
      provider: "openai",
      family: "gpt-oss",
      providerDisplayName: "OpenAI",
      invocation: "converse",
      supportsPromptCaching: false,
      supportsVision: false,
    });
  });

  it("is enabled for no purpose without a model_enablement row", async () => {
    const db = fakeDb(seededRows([{ modelId: "nova-pro", purpose: "chat" }]));
    for (const purpose of MODEL_PURPOSES) {
      expect(await isModelEnabled(db, "gpt-oss-120b", purpose)).toBe(false);
      expect(await enabledModelsForPurpose(db, purpose)).not.toContain(
        "gpt-oss-120b",
      );
    }
  });

  it("cannot be selected for a turn by id or Bedrock id without a row, and can with one", () => {
    for (const requestedModelId of [
      "gpt-oss-120b",
      MODELS["gpt-oss-120b"].bedrockModelId,
    ]) {
      const base = {
        requestedModelId,
        route: directRoute,
        runtimeName: "bedrock" as const,
        directModelId: undefined,
        forceRequestedModel: true,
      };
      const without = resolveRuntimeModelSelection({
        ...base,
        enabledModelIds: new Set([...SEEDED, "nova-pro"]),
      });
      expect(without.modelId).not.toBe("gpt-oss-120b");
      expect(without.reason).toBe("default_model_fallback");
      expect(
        resolveRuntimeModelSelection({
          ...base,
          enabledModelIds: new Set([...SEEDED, "gpt-oss-120b"]),
        }),
      ).toMatchObject({
        modelId: "gpt-oss-120b",
        providerModelId: "openai.gpt-oss-120b-1:0",
      });
    }
  });

  it("keeps summaries, routing and memory-capture on Claude even when it is the chat brain", async () => {
    const db = fakeDb(seededRows([{ modelId: "gpt-oss-120b", purpose: "chat" }]));
    expect(await enabledModelsForPurpose(db, "chat")).toContain("gpt-oss-120b");
    for (const purpose of ["summaries", "routing", "memory-capture"] as const) {
      const resolved = await resolveModelForPurpose(db, purpose, {
        preferred: "gpt-oss-120b",
      });
      expect(MODELS[resolved].provider).toBe("anthropic");
    }
  });

  it("joins the failover chain last, and only with its own row", () => {
    expect(
      orderModelCandidatesForPurpose("chat", SEEDED, "gpt-oss-120b"),
    ).toEqual(["sonnet-4-6", "opus-4-7", "haiku-4-5"]);
    expect(
      orderModelCandidatesForPurpose(
        "chat",
        [...SEEDED, "gpt-oss-120b"],
        "sonnet-4-6",
      ),
    ).toEqual(["sonnet-4-6", "opus-4-7", "haiku-4-5", "gpt-oss-120b"]);
  });
});
