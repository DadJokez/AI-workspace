import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";

export type ActivityState = "pending" | "succeeded" | "failed";

export interface AgentActivityEvent {
  id: string;
  state: ActivityState;
  label: string;
  detail?: string;
  at?: string;
}

export function buildToolActivityEvents(
  calls: readonly PersistedToolCall[] = [],
  results: readonly PersistedToolResult[] = [],
): AgentActivityEvent[] {
  const resultByCallId = new Map(results.map((r) => [r.toolCallId, r]));
  const callIds = new Set(calls.map((c) => c.id));

  const callEvents = calls.map((call) => {
    const result = resultByCallId.get(call.id);
    return {
      id: call.id,
      state: result ? (result.isError ? "failed" : "succeeded") : "pending",
      label: result
        ? result.isError
          ? `Failed ${formatToolLabel(call)}`
          : `Ran ${formatToolLabel(call)}`
        : `Calling ${formatToolLabel(call)}`,
      detail: summarizePayload(result?.output ?? call.input),
      at: result?.completedAt ?? call.startedAt,
    } satisfies AgentActivityEvent;
  });

  const orphanResults = results
    .filter((result) => !callIds.has(result.toolCallId))
    .map((result) => ({
      id: result.toolCallId,
      state: result.isError ? "failed" : "succeeded",
      label: result.isError ? "Tool failed" : "Tool finished",
      detail: summarizePayload(result.output),
      at: result.completedAt,
    }) satisfies AgentActivityEvent);

  return [...callEvents, ...orphanResults].sort((a, b) =>
    (a.at ?? "").localeCompare(b.at ?? ""),
  );
}

export function summarizeActivity(
  events: readonly AgentActivityEvent[],
  pending: boolean | undefined,
  status: string | undefined,
): string | undefined {
  if (pending && status) return status;
  if (events.length === 0) return pending ? "Thinking..." : undefined;
  const failed = events.filter((event) => event.state === "failed").length;
  if (failed > 0) return `${failed} tool ${failed === 1 ? "failed" : "failures"}`;
  const pendingCount = events.filter((event) => event.state === "pending").length;
  if (pendingCount > 0) {
    return `${pendingCount} tool ${pendingCount === 1 ? "running" : "running"}`;
  }
  return `Ran ${events.length} ${events.length === 1 ? "tool" : "tools"}`;
}

function formatToolLabel(call: PersistedToolCall): string {
  const provider = call.provider ? titleize(call.provider) : undefined;
  const toolName = humanize(call.toolName || call.name);
  return provider ? `${provider} · ${toolName}` : toolName;
}

function titleize(value: string): string {
  if (value.toLowerCase() === "github") return "GitHub";
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ");
}

function summarizePayload(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const text =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const compact = text.replace(/\s+/g, " ").trim();
    if (!compact) return undefined;
    return compact.length > 220 ? `${compact.slice(0, 219)}...` : compact;
  } catch {
    return undefined;
  }
}
