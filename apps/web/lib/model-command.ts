import { isValidModelId, type ModelId } from "@ai-workspace/agent";

export type ChatModelOverride =
  | { mode: "model"; modelId: ModelId; label: string }
  | { mode: "auto"; label: "auto" };

export interface ParsedModelCommand {
  override: ChatModelOverride;
  body: string;
}

const MODEL_COMMAND_RE = /^\/model(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i;

const MODEL_ALIASES: Record<string, ModelId | "auto"> = {
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
};

export function isModelCommandInput(input: string): boolean {
  return /^\/model(?:\s|$)/i.test(input.trimStart());
}

export function parseModelCommand(input: string): ParsedModelCommand | null {
  const match = MODEL_COMMAND_RE.exec(input.trimStart());
  if (!match) return null;

  const rawModel = (match[1] ?? "").trim().toLowerCase();
  const body = (match[2] ?? "").trimStart();
  if (!rawModel) return null;

  const mapped = MODEL_ALIASES[rawModel] ?? (isValidModelId(rawModel) ? rawModel : null);
  if (!mapped) return null;

  if (mapped === "auto") {
    return {
      override: { mode: "auto", label: "auto" },
      body,
    };
  }

  return {
    override: {
      mode: "model",
      modelId: mapped,
      label: rawModel,
    },
    body,
  };
}

export function modelCommandUsageMessage(): string {
  return "Use /model sonnet, /model haiku, /model opus, or /model auto followed by a message.";
}

export function buildModelCommandDisplayMessage(
  override: ChatModelOverride,
  body: string,
): string {
  const token =
    override.mode === "model" ? override.label || override.modelId : "auto";
  const trimmedBody = body.trim();
  return trimmedBody ? `/model ${token} ${trimmedBody}` : `/model ${token}`;
}
