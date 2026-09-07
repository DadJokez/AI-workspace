import type { BedrockMessage } from "./clients";
import type { BedrockToolConfig } from "./registry";

/** Historical schemas satisfy Converse, but never grant execution permission. */
export function withToolHistory(
  config: BedrockToolConfig | undefined,
  messages: readonly BedrockMessage[],
): BedrockToolConfig | undefined {
  const names = new Set<string>();
  let hasResults = false;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.kind === "tool-use") names.add(block.name);
      if (block.kind === "tool-result") hasResults = true;
    }
  }
  if (!names.size && hasResults && !config) names.add("history_only");
  const missing = [...names].filter(
    (name) => !config?.tools.some((tool) => tool.toolSpec.name === name),
  );
  if (!missing.length) return config;
  return {
    ...config,
    tools: [
      ...(config?.tools ?? []),
      ...missing.map((name) => ({
        toolSpec: {
          name,
          description: "Historical tool only. Unavailable for execution in this step; use its existing results.",
          inputSchema: { json: { type: "object", properties: {} } },
        },
      })),
    ],
  };
}
