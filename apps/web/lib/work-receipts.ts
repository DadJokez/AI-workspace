import type { ActivityState, AgentActivityEvent } from "@/lib/activity-events";

export type WorkReceiptKind =
  | "attention"
  | "browser"
  | "deployment"
  | "github"
  | "lifecycle"
  | "tool"
  | "workspace";

export interface WorkReceiptStep {
  id: string;
  state: ActivityState;
  label: string;
  detail?: string;
}

export interface WorkReceipt {
  id: string;
  kind: WorkReceiptKind;
  state: ActivityState;
  summary: string;
  steps: WorkReceiptStep[];
}

export function buildWorkReceipts(
  events: readonly AgentActivityEvent[],
  {
    pending = false,
    fallbackSummary,
  }: {
    pending?: boolean;
    fallbackSummary?: string;
  } = {},
): WorkReceipt[] {
  const ordered = [...events].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

  if (pending) {
    return [buildPendingReceipt(ordered, fallbackSummary)];
  }

  if (ordered.length === 0) return [];

  const failedEvents = ordered.filter((event) => event.state === "failed");
  const receipts: WorkReceipt[] = [];
  if (failedEvents.length > 0) {
    receipts.push({
      id: "attention",
      kind: "attention",
      state: "failed",
      summary: formatAttentionSummary(failedEvents.length),
      steps: failedEvents.map(toReceiptStep),
    });
  }

  const succeededEvents = ordered.filter((event) => event.state !== "failed");
  const groups = groupByKind(succeededEvents);
  const nonLifecycleKinds = [...groups.keys()].filter((kind) => kind !== "lifecycle");
  const visibleKinds =
    nonLifecycleKinds.length > 0 ? nonLifecycleKinds : [...groups.keys()];

  for (const kind of visibleKinds) {
    const groupEvents = groups.get(kind) ?? [];
    if (groupEvents.length === 0) continue;
    receipts.push({
      id: kind,
      kind,
      state: aggregateState(groupEvents),
      summary: summarizeGroup(kind, groupEvents),
      steps: groupEvents.map(toReceiptStep),
    });
  }

  return receipts;
}

function buildPendingReceipt(
  events: readonly AgentActivityEvent[],
  fallbackSummary?: string,
): WorkReceipt {
  const failedEvents = events.filter((event) => event.state === "failed");
  if (failedEvents.length > 0) {
    return {
      id: "active-attention",
      kind: "attention",
      state: "failed",
      summary: formatAttentionSummary(failedEvents.length),
      steps: events.slice(-6).map(toReceiptStep),
    };
  }

  const activeEvent =
    [...events].reverse().find((event) => event.state === "pending") ??
    events[events.length - 1];
  const summary = activeEvent?.label ?? fallbackSummary ?? "Thinking...";
  return {
    id: "active-work",
    kind: activeEvent ? classifyEvent(activeEvent) : "lifecycle",
    state: "pending",
    summary: `Working... ${formatProgressLabel(summary)}`,
    steps: events.slice(-6).map(toReceiptStep),
  };
}

function groupByKind(events: readonly AgentActivityEvent[]) {
  const groups = new Map<WorkReceiptKind, AgentActivityEvent[]>();
  for (const event of events) {
    const kind = classifyEvent(event);
    groups.set(kind, [...(groups.get(kind) ?? []), event]);
  }
  return groups;
}

function classifyEvent(event: AgentActivityEvent): WorkReceiptKind {
  if (event.state === "failed") return "attention";
  const label = event.label.toLowerCase();

  if (/\bgithub\b|\bpr\b|pull request|issue/.test(label)) return "github";
  if (/browser|dom|screenshot|page|chrome|refresh/.test(label)) return "browser";
  if (/deploy|deployment|codebuild|ecs|health check|service/.test(label)) {
    return "deployment";
  }
  if (
    /workspace|file|searched|searching|checked local|local notes|source|command|shell|typecheck|lint|build|validated/.test(
      label,
    )
  ) {
    return "workspace";
  }
  if (/tool|mcp|provider|cursor|runtime/.test(label)) return "tool";
  return "lifecycle";
}

function aggregateState(events: readonly AgentActivityEvent[]): ActivityState {
  if (events.some((event) => event.state === "failed")) return "failed";
  if (events.some((event) => event.state === "pending")) return "pending";
  return "succeeded";
}

function summarizeGroup(
  kind: WorkReceiptKind,
  events: readonly AgentActivityEvent[],
): string {
  if (kind === "attention") return formatAttentionSummary(events.length);
  if (kind === "github") {
    return labelsContain(events, /pull request|\bpr\b/)
      ? "Checked GitHub pull requests"
      : "Checked GitHub";
  }
  if (kind === "browser") return "Used the browser";
  if (kind === "deployment") return "Checked deployment";
  if (kind === "tool") return summarizeToolGroup(events);
  if (kind === "workspace") return summarizeWorkspaceGroup(events);

  if (labelsContain(events, /cancel/)) return "Run canceled";
  if (labelsContain(events, /stored assistant answer|finished response|run completed/)) {
    return "Finished response";
  }
  return `Worked through ${formatStepCount(events.length)}`;
}

function summarizeWorkspaceGroup(events: readonly AgentActivityEvent[]): string {
  const searchCount = countLabels(events, /search/);
  const readCount = countLabels(events, /read|checked local|checked .*details|file/);
  const commandCount = countLabels(events, /command|ran |typecheck|lint|build|validated/);
  const parts: string[] = [];
  if (readCount > 0) parts.push(`${readCount} ${readCount === 1 ? "file" : "files"}`);
  if (searchCount > 0) {
    parts.push(`${searchCount} ${searchCount === 1 ? "search" : "searches"}`);
  }
  if (commandCount > 0) {
    parts.push(`ran ${commandCount} ${commandCount === 1 ? "command" : "commands"}`);
  }
  return parts.length > 0
    ? `Explored ${formatInlineList(parts)}`
    : `Explored workspace`;
}

function summarizeToolGroup(events: readonly AgentActivityEvent[]): string {
  if (labelsContain(events, /provider run|runtime/)) return "Used runtime tools";
  return `Used ${formatStepCount(events.length)}`;
}

function toReceiptStep(event: AgentActivityEvent): WorkReceiptStep {
  return {
    id: event.id,
    state: event.state,
    label: event.label,
    ...(event.detail ? { detail: event.detail } : {}),
  };
}

function formatProgressLabel(label: string): string {
  const cleaned = label.replace(/\.\.\.$/, "").replace(/\s+/g, " ").trim();
  const lower = cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
  return lower
    .replace(/^searched\b/, "searching")
    .replace(/^checked\b/, "checking")
    .replace(/^started\b/, "starting")
    .replace(/^queued\b/, "queueing")
    .replace(/^stored\b/, "storing")
    .replace(/^finished\b/, "finishing")
    .replace(/^first token streamed$/i, "streaming response");
}

function formatAttentionSummary(count: number): string {
  return `${count} ${count === 1 ? "step needs" : "steps need"} attention`;
}

function formatStepCount(count: number): string {
  return `${count} ${count === 1 ? "step" : "steps"}`;
}

function countLabels(
  events: readonly AgentActivityEvent[],
  pattern: RegExp,
): number {
  return events.filter((event) => pattern.test(event.label.toLowerCase())).length;
}

function labelsContain(
  events: readonly AgentActivityEvent[],
  pattern: RegExp,
): boolean {
  return events.some((event) => pattern.test(event.label.toLowerCase()));
}

function formatInlineList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}
