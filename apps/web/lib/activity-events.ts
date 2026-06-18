import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";

export type ActivityState = "pending" | "succeeded" | "failed";

/**
 * Receipt bucket for an activity event (#119). Categories group low-level
 * steps into user-meaningful work receipts: "Checked GitHub · 4 steps"
 * instead of four separate rows.
 */
export type ActivityCategory =
  | "context"
  | "github"
  | "workspace"
  | "tools"
  | "progress";

export interface AgentActivityEvent {
  id: string;
  state: ActivityState;
  label: string;
  detail?: string;
  at?: string;
  /** Receipt bucket; older persisted events may omit it (inferred later). */
  category?: ActivityCategory;
}

/** Map a tool call's provider/name onto a receipt category. */
export function categorizeTool(
  provider: string | null | undefined,
  toolName: string | null | undefined,
): ActivityCategory {
  const p = (provider ?? "").toLowerCase();
  if (p === "github") return "github";
  if (isShellLike(`${toolName ?? ""}`.toLowerCase())) return "workspace";
  return "tools";
}

export function buildToolActivityEvents(
  calls: readonly PersistedToolCall[] = [],
  results: readonly PersistedToolResult[] = [],
): AgentActivityEvent[] {
  const resultByCallId = new Map(results.map((r) => [r.toolCallId, r]));
  const callIds = new Set(calls.map((c) => c.id));

  const callEvents = calls.map((call) => {
    const result = resultByCallId.get(call.id);
    const state: ActivityState = result
      ? result.isError
        ? "failed"
        : "succeeded"
      : "pending";
    return {
      id: call.id,
      state,
      label: describeActivityStep(call, state),
      detail: result?.isError ? summarizePayload(result.output) : undefined,
      at: result?.completedAt ?? call.startedAt,
      category: categorizeTool(call.provider, `${call.name} ${call.toolName}`),
    } satisfies AgentActivityEvent;
  });

  const orphanResults = results
    .filter((result) => !callIds.has(result.toolCallId))
    .map((result) => ({
      id: result.toolCallId,
      state: result.isError ? "failed" : "succeeded",
      label: result.isError ? "Tool step needs attention" : "Finished a step",
      detail: result.isError ? summarizePayload(result.output) : undefined,
      at: result.completedAt,
      category: "tools",
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
  if (failed > 0) return `${failed} step ${failed === 1 ? "needs" : "need"} attention`;
  const pendingCount = events.filter((event) => event.state === "pending").length;
  if (pending && pendingCount > 0) {
    return `${pendingCount} ${pendingCount === 1 ? "step" : "steps"} running`;
  }
  const latest = events[events.length - 1];
  if (!pending && latest?.state === "succeeded") {
    if (/stored assistant answer/i.test(latest.label)) {
      return "Finished response";
    }
    if (/run canceled/i.test(latest.label)) {
      return "Run canceled";
    }
  }
  return events.length > 1 ? "Finished research" : "Finished checking";
}

function describeActivityStep(
  call: PersistedToolCall,
  state: ActivityState,
): string {
  if (state === "failed") {
    return `Could not ${toInfinitiveActivityVerb(baseActivityVerb(call))}`;
  }
  if (state === "pending") return `${capitalize(baseActivityVerb(call, true))}...`;
  return capitalize(baseActivityVerb(call));
}

function toInfinitiveActivityVerb(value: string): string {
  return value
    .replace(/^searched\b/, "search")
    .replace(/^checked\b/, "check")
    .replace(/^compared\b/, "compare")
    .replace(/^extracted\b/, "extract")
    .replace(/^updated\b/, "update");
}

function baseActivityVerb(
  call: PersistedToolCall,
  progressive = false,
): string {
  const toolName = `${call.name} ${call.toolName}`.toLowerCase();
  const command = commandText(call.input).toLowerCase();
  const provider = call.provider ? titleize(call.provider) : undefined;
  const target = provider ?? "sources";

  if (isShellLike(toolName)) {
    if (/\b(rg|grep|find|search|curl)\b/.test(command)) {
      return progressive
        ? "searching company AI references"
        : "searched company AI references";
    }
    if (/\b(diff|comm|cmp)\b/.test(command)) {
      return progressive ? "comparing source snippets" : "compared source snippets";
    }
    if (/\b(jq|node|python|awk|sed)\b/.test(command)) {
      return progressive ? "extracting supporting facts" : "extracted supporting facts";
    }
    if (/\b(cat|ls|pwd|head|tail|wc)\b/.test(command)) {
      return progressive ? "checking local notes" : "checked local notes";
    }
    return progressive ? "checking the workspace" : "checked the workspace";
  }

  if (/(search|query|find|list|lookup)/.test(toolName)) {
    return progressive ? `searching ${target}` : `searched ${target}`;
  }
  if (/(get|read|fetch|open|view|inspect)/.test(toolName)) {
    return progressive ? `checking ${target} details` : `checked ${target} details`;
  }
  if (/(compare|diff|review)/.test(toolName)) {
    return progressive ? "comparing source snippets" : "compared source snippets";
  }
  if (/(extract|parse|summarize|analyse|analyze)/.test(toolName)) {
    return progressive ? "extracting supporting facts" : "extracted supporting facts";
  }
  if (/(create|update|write|post|send|merge|deploy)/.test(toolName)) {
    return progressive ? `updating ${target}` : `updated ${target}`;
  }

  return progressive ? `checking ${target}` : `checked ${target}`;
}

function titleize(value: string): string {
  if (value.toLowerCase() === "github") return "GitHub";
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function isShellLike(toolName: string): boolean {
  return /(shell|exec|terminal|command|bash|zsh)/.test(toolName);
}

function commandText(input: Record<string, unknown>): string {
  for (const key of ["cmd", "command", "query", "search_term", "pattern"]) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return "";
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
