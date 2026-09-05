import { DEFAULT_MODEL_ID, MODEL_IDS, MODELS } from "@ai-workspace/agent";
import { describe, expect, it } from "vitest";
import {
  buildModelCommandDisplayMessage,
  isModelCommandInput,
  modelCommandAliases,
  modelCommandUsageMessage,
  parseModelCommand,
} from "@/lib/model-command";

describe("model slash command", () => {
  it("detects only /model commands", () => {
    expect(isModelCommandInput("/model sonnet hello")).toBe(true);
    expect(isModelCommandInput("  /model auto hello")).toBe(true);
    expect(isModelCommandInput("/weekly-status hello")).toBe(false);
    expect(isModelCommandInput("model sonnet hello")).toBe(false);
  });

  it("parses one-turn concrete model overrides", () => {
    expect(parseModelCommand("/model sonnet draft this")).toEqual({
      override: { mode: "model", modelId: "sonnet-4-5", label: "sonnet" },
      body: "draft this",
    });
    expect(parseModelCommand("/model haiku quick ping")).toEqual({
      override: { mode: "model", modelId: "haiku-4-5", label: "haiku" },
      body: "quick ping",
    });
    expect(parseModelCommand("/model opus think hard")).toEqual({
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
    it("pins the vocabulary the former hand table offered", () => {
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
        deep: "opus-4-7",
        opus: "opus-4-7",
        "opus-4-7": "opus-4-7",
        "claude-opus": "opus-4-7",
        // #797 P3: the first non-Claude entry adds only its own names. The
        // role words above are unchanged — `fast` stays Haiku even though
        // Nova Pro is cheaper — because role words never cross vendors.
        nova: "nova-pro",
        "nova-pro": "nova-pro",
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
      // The cheapest model overall is the other vendor's; a role word must
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

    it("lists every short name in the usage message", () => {
      expect(modelCommandUsageMessage()).toBe(
        "Use /model haiku, /model sonnet, /model opus, /model nova, or /model auto followed by a message.",
      );
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
