export type ChatExecutionMode = "local" | "cloud";

export function parseChatExecutionMode(value: unknown): ChatExecutionMode {
  return value === "cloud" ? "cloud" : "local";
}
