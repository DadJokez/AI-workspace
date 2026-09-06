import {
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  MODELS,
  type ModelId,
} from "@ai-workspace/agent";
import { describe, expect, it } from "vitest";
import {
  buildModelCommandDisplayMessage,
  isModelCommandInput,
  modelCommandAliases,
  modelCommandUsageMessage,
  parseModelCommand,
} from "@/lib/model-command";

/**
 * The chat-enabled vocabulary the route passes in today: the three seeded
 * Claude tiers plus the pinned default (#797 P5). Everything registered on
 * 2026-09-06 is disabled and must be invisible through this set.
 */
const ENABLED_FOR_CHAT: ModelId[] = [
  "haiku-4-5",
  "sonnet-4-5",
  "sonnet-4-6",
  "opus-4-7",
];

describe("model slash command", () => {
  it("detects only /model commands", () => {
    expect(isModelCommandInput("/model sonnet hello")).toBe(true);
    expect(isModelCommandInput("  /model auto hello")).toBe(true);
    expect(isModelCommandInput("/weekly-status hello")).toBe(false);
    expect(isModelCommandInput("model sonnet hello")).toBe(false);
  });

  it("parses one-turn concrete model overrides over the enabled vocabulary", () => {
    expect(parseModelCommand("/model sonnet draft this", ENABLED_FOR_CHAT)).toEqual({
      override: { mode: "model", modelId: "sonnet-4-5", label: "sonnet" },
      body: "draft this",
    });
    expect(parseModelCommand("/model haiku quick ping", ENABLED_FOR_CHAT)).toEqual({
      override: { mode: "model", modelId: "haiku-4-5", label: "haiku" },
      body: "quick ping",
    });
    expect(parseModelCommand("/model opus think hard", ENABLED_FOR_CHAT)).toEqual({
      override: { mode: "model", modelId: "opus-4-7", label: "opus" },
      body: "think hard",
    });
  });

  it("parses one-turn auto mode", () => {
    expect(parseModelCommand("/model auto route normally")).toEqual({
      override: { mode: "auto", label: "auto" },
      body: "route normally",
    });
  });

  it("rejects malformed model commands", () => {
    expect(parseModelCommand("/model")).toBeNull();
    expect(parseModelCommand("/model llama hello")).toBeNull();
    expect(modelCommandUsageMessage()).toContain("/model sonnet");
  });

  describe("registry-derived aliases (#797 P1)", () => {
    it("pins the whole-registry vocabulary", () => {
      expect(modelCommandAliases()).toEqual({
        auto: "auto",
        autopilot: "auto",
        default: "auto",
        fast: "haiku-4-5",
        haiku: "haiku-4-5",
        "haiku-4-5": "haiku-4-5",
        "claude-haiku": "haiku-4-5",
        quality: "sonnet-4-5",
        sonnet: "sonnet-4-5",
        "sonnet-4-5": "sonnet-4-5",
        "sonnet-4-6": "sonnet-4-6",
        "claude-sonnet": "sonnet-4-5",
        "opus-4-7": "opus-4-7",
        // #797 P3: the first non-Claude entry adds only its own names. The
        // role words above are unchanged — `fast` stays Haiku even though
        // Nova Pro is cheaper — because role words never cross vendors.
        nova: "nova-pro",
        "nova-pro": "nova-pro",
        // #797 P5 (2026-09-06 gaggle): each entry adds its id, slug and
        // short name; a shared short name goes to the newest entry and
        // `deep` to the priciest same-vendor output. Over the WHOLE registry
        // that is Opus 5 / Fable 5.1 — both disabled — which is exactly why
        // the chat route never resolves against this table (see the
        // enabled-vocabulary tests below).
        "qwen3-32b": "qwen3-32b",
        "qwen3-next-80b": "qwen3-next-80b",
        qwen3: "qwen3-next-80b",
        "kimi-k2-5": "kimi-k2-5",
        kimi: "kimi-k2-5",
        "glm-4-7": "glm-4-7",
        "glm-5": "glm-5",
        glm: "glm-5",
        "nemotron-super-3-120b": "nemotron-super-3-120b",
        "nemotron-3-super-120b": "nemotron-super-3-120b",
        nemotron: "nemotron-super-3-120b",
        "deepseek-v3-2": "deepseek-v3-2",
        deepseek: "deepseek-v3-2",
        "sonnet-5": "sonnet-5",
        "opus-5": "opus-5",
        opus: "opus-5",
        "claude-opus": "opus-5",
        deep: "fable-5-1",
        "fable-5-1": "fable-5-1",
        fable: "fable-5-1",
        "claude-fable": "fable-5-1",
      });
    });

    it("reaches every registry model by id and by display-name slug", () => {
      for (const id of MODEL_IDS) {
        const slug = MODELS[id].displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        expect(parseModelCommand(`/model ${id} hi`)?.override).toEqual({
          mode: "model",
          modelId: id,
          label: id,
        });
        expect(parseModelCommand(`/model ${slug} hi`)?.override).toMatchObject({
          modelId: id,
        });
      }
    });

    it("resolves a shared short name to the app default and role words by registry cost within the default's vendor", () => {
      const aliases = modelCommandAliases();
      expect(aliases.sonnet).toBe(DEFAULT_MODEL_ID);
      expect(aliases.quality).toBe(DEFAULT_MODEL_ID);
      const sameVendor = MODEL_IDS.filter(
        (id) => MODELS[id].provider === MODELS[DEFAULT_MODEL_ID].provider,
      );
      expect(sameVendor.length).toBeLessThan(MODEL_IDS.length);
      const byTotalCost = [...sameVendor].sort(
        (a, b) =>
          MODELS[a].costPer1MInput +
          MODELS[a].costPer1MOutput -
          (MODELS[b].costPer1MInput + MODELS[b].costPer1MOutput),
      );
      expect(aliases.fast).toBe(byTotalCost[0]);
      const byOutputCost = [...sameVendor].sort(
        (a, b) => MODELS[b].costPer1MOutput - MODELS[a].costPer1MOutput,
      );
      expect(aliases.deep).toBe(byOutputCost[0]);
      // The cheapest model overall is another vendor's; a role word must
      // not reach it.
      const cheapestOverall = [...MODEL_IDS].sort(
        (a, b) =>
          MODELS[a].costPer1MInput +
          MODELS[a].costPer1MOutput -
          (MODELS[b].costPer1MInput + MODELS[b].costPer1MOutput),
      )[0]!;
      expect(MODELS[cheapestOverall].provider).not.toBe(
        MODELS[DEFAULT_MODEL_ID].provider,
      );
      expect(aliases.fast).not.toBe(cheapestOverall);
    });

    it("lists every short name in the whole-registry usage message", () => {
      expect(modelCommandUsageMessage()).toBe(
        "Use /model haiku, /model sonnet, /model opus, /model nova, /model qwen3, /model kimi, /model glm, /model nemotron, /model deepseek, /model fable, or /model auto followed by a message.",
      );
    });
  });

  describe("enabled vocabulary (#797 P5)", () => {
    it("is the pre-gaggle table when only the seeded Claude tiers are enabled", () => {
      // Byte-identical to what the route resolved before 2026-09-06: a
      // registered-but-disabled brain adds nothing and steals nothing.
      expect(modelCommandAliases(ENABLED_FOR_CHAT)).toEqual({
        auto: "auto",
        autopilot: "auto",
        default: "auto",
        fast: "haiku-4-5",
        haiku: "haiku-4-5",
        "haiku-4-5": "haiku-4-5",
        "claude-haiku": "haiku-4-5",
        quality: "sonnet-4-5",
        sonnet: "sonnet-4-5",
        "sonnet-4-5": "sonnet-4-5",
        "sonnet-4-6": "sonnet-4-6",
        "claude-sonnet": "sonnet-4-5",
        deep: "opus-4-7",
        opus: "opus-4-7",
        "opus-4-7": "opus-4-7",
        "claude-opus": "opus-4-7",
      });
    });

    it("keeps `opus` and `deep` on the enabled Opus while Opus 5 and Fable 5.1 are registered but disabled", () => {
      expect(parseModelCommand("/model opus hi", ENABLED_FOR_CHAT)?.override).toMatchObject({
        modelId: "opus-4-7",
      });
      expect(parseModelCommand("/model deep hi", ENABLED_FOR_CHAT)?.override).toMatchObject({
        modelId: "opus-4-7",
      });
    });

    it("refuses every disabled entry by id, slug and short name", () => {
      const disabled = MODEL_IDS.filter((id) => !ENABLED_FOR_CHAT.includes(id));
      expect(disabled.length).toBeGreaterThanOrEqual(11);
      for (const id of disabled) {
        const slug = MODELS[id].displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        for (const alias of [id, slug, slug.split("-")[0]!]) {
          const parsed = parseModelCommand(`/model ${alias} hi`, ENABLED_FOR_CHAT);
          expect(parsed === null || ENABLED_FOR_CHAT.includes(parsed.override.mode === "model" ? parsed.override.modelId : DEFAULT_MODEL_ID)).toBe(true);
        }
      }
      expect(parseModelCommand("/model fable hi", ENABLED_FOR_CHAT)).toBeNull();
      expect(parseModelCommand("/model kimi hi", ENABLED_FOR_CHAT)).toBeNull();
      expect(parseModelCommand("/model nova hi", ENABLED_FOR_CHAT)).toBeNull();
    });

    it("lists only enabled short names in the usage message", () => {
      expect(modelCommandUsageMessage(ENABLED_FOR_CHAT)).toBe(
        "Use /model haiku, /model sonnet, /model opus, or /model auto followed by a message.",
      );
      // While the platform pin holds, the route's vocabulary is the pin.
      expect(modelCommandUsageMessage(["sonnet-4-5"])).toBe(
        "Use /model sonnet, or /model auto followed by a message.",
      );
      expect(parseModelCommand("/model haiku hi", ["sonnet-4-5"])).toBeNull();
    });
  });

  it("formats visible model command messages for chat history", () => {
    expect(
      buildModelCommandDisplayMessage(
        { mode: "model", modelId: "sonnet-4-5", label: "sonnet" },
        "draft this",
      ),
    ).toBe("/model sonnet draft this");
    expect(
      buildModelCommandDisplayMessage({ mode: "auto", label: "auto" }, "hi"),
    ).toBe("/model auto hi");
  });
});
