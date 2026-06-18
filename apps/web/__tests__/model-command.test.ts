import { describe, expect, it } from "vitest";
import {
  buildModelCommandDisplayMessage,
  isModelCommandInput,
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
      override: { mode: "model", modelId: "sonnet-4-6", label: "sonnet" },
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

  it("formats visible model command messages for chat history", () => {
    expect(
      buildModelCommandDisplayMessage(
        { mode: "model", modelId: "sonnet-4-6", label: "sonnet" },
        "draft this",
      ),
    ).toBe("/model sonnet draft this");
    expect(
      buildModelCommandDisplayMessage({ mode: "auto", label: "auto" }, "hi"),
    ).toBe("/model auto hi");
  });
});
