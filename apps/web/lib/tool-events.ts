import type { ToolCall, ToolResult } from "@ai-workspace/agent";
import { redactToolCall, redactToolResult } from "@/lib/tool-redaction";

export interface PersistedToolCall {
  id: string;
  name: string;
  provider: string | null;
  toolName: string;
  input: Record<string, unknown>;
  startedAt: string;
}

export interface PersistedToolResult {
  toolCallId: string;
  name?: string;
  provider?: string | null;
  toolName?: string;
  output: unknown;
  isError: boolean;
  completedAt: string;
}

export interface ToolEventAccumulator {
  recordCall(call: ToolCall): void;
  recordResult(result: ToolResult): void;
  calls(): PersistedToolCall[];
  results(): PersistedToolResult[];
}

export function createToolEventAccumulator(
  providerHints: readonly string[] = [],
  now: () => Date = () => new Date(),
): ToolEventAccumulator {
  const callsById = new Map<string, PersistedToolCall>();
  const resultsById = new Map<string, PersistedToolResult>();

  return {
    recordCall(call) {
      const existing = callsById.get(call.id);
      const parsed = parseToolName(call.name, providerHints);
      callsById.set(
        call.id,
        redactToolCall({
          id: call.id,
          name: call.name,
          provider: parsed.provider,
          toolName: parsed.toolName,
          input: call.input,
          startedAt: existing?.startedAt ?? now().toISOString(),
        }),
      );
    },
    recordResult(result) {
      const call = callsById.get(result.toolCallId);
      resultsById.set(
        result.toolCallId,
        redactToolResult({
          toolCallId: result.toolCallId,
          ...(call
            ? {
                name: call.name,
                provider: call.provider,
                toolName: call.toolName,
              }
            : {}),
          output: result.output,
          isError: result.isError === true,
          completedAt: now().toISOString(),
        }),
      );
    },
    calls() {
      return Array.from(callsById.values());
    },
    results() {
      return Array.from(resultsById.values());
    },
  };
}

export function parseToolName(
  name: string,
  providerHints: readonly string[] = [],
): { provider: string | null; toolName: string } {
  const mcpName = /^mcp__([^_]+)__(.+)$/.exec(name);
  if (mcpName) {
    return { provider: mcpName[1]!, toolName: mcpName[2]! };
  }

  for (const separator of [".", "/", "__"]) {
    const idx = name.indexOf(separator);
    if (idx > 0 && idx < name.length - separator.length) {
      return {
        provider: name.slice(0, idx),
        toolName: name.slice(idx + separator.length),
      };
    }
  }

  const provider = [...providerHints]
    .sort((a, b) => b.length - a.length)
    .find((hint) => name.startsWith(`${hint}_`));

  if (provider) {
    return {
      provider,
      toolName: name.slice(provider.length + 1),
    };
  }

  return { provider: null, toolName: name };
}
