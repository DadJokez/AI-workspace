import type {
  ActivityCategory,
  ActivityState,
  AgentActivityEvent,
} from "@/lib/activity-events";

/**
 * Work receipts (#119): aggregate low-level activity events into a few
 * user-meaningful rows — "Checked GitHub · 4 steps" — so the assistant's
 * answer stays visually primary and the work is inspectable on demand.
 */
export interface ActivityReceipt {
  id: string;
  category: ActivityCategory;
  /** Compact row text, e.g. "Checked GitHub · 4 steps". */
  label: string;
  state: ActivityState;
  events: AgentActivityEvent[];
}

const CATEGORY_ORDER: ActivityCategory[] = [
  "context",
  "github",
  "tools",
  "workspace",
  "progress",
];

const CATEGORY_LABELS: Record<
  ActivityCategory,
  { one: (label: string) => string; many: (n: number) => string }
> = {
  context: {
    one: (label) => label,
    many: (n) => `Checked context · ${n} updates`,
  },
  github: {
    one: (label) => label,
    many: (n) => `Checked GitHub · ${n} steps`,
  },
  workspace: {
    one: (label) => label,
    many: (n) => `Worked in the workspace · ${n} steps`,
  },
  tools: {
    one: (label) => label,
    many: (n) => `Used connected tools · ${n} steps`,
  },
  progress: {
    one: (label) => label,
    many: (n) => `Run progress · ${n} updates`,
  },
};

/**
 * Group events into receipts, preserving the order work actually happened
 * (receipts sort by their earliest event; ties fall back to a stable
 * category order). Events without a category — older persisted rows — are
 * inferred from their label so history renders identically.
 */
export function groupActivityEvents(
  events: readonly AgentActivityEvent[],
): ActivityReceipt[] {
  const buckets = new Map<ActivityCategory, AgentActivityEvent[]>();
  for (const event of events) {
    const category = event.category ?? inferCategory(event.label);
    const bucket = buckets.get(category);
    if (bucket) bucket.push(event);
    else buckets.set(category, [event]);
  }

  const receipts: ActivityReceipt[] = [];
  for (const category of CATEGORY_ORDER) {
    const bucket = buckets.get(category);
    if (!bucket || bucket.length === 0) continue;
    receipts.push({
      id: `receipt-${category}`,
      category,
      label: receiptLabel(category, bucket),
      state: aggregateState(bucket),
      events: bucket,
    });
  }

  return receipts.sort((a, b) => {
    const aAt = firstTimestamp(a.events);
    const bAt = firstTimestamp(b.events);
    if (aAt && bAt && aAt !== bAt) return aAt.localeCompare(bAt);
    return (
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
    );
  });
}

/**
 * Deterministic collapsed headline from structured receipts. Lifecycle noise
 * stays in the expanded view; the quiet line favors concrete tool, mutation,
 * validation, and publish outcomes.
 */
export function summarizeActivityReceipts(
  events: readonly AgentActivityEvent[],
): string | undefined {
  let labels = groupActivityEvents(events)
    .map(compactReceiptLabel)
    .filter((label): label is string => Boolean(label));
  if (labels.length > 1) {
    labels = labels.filter((label) => label !== "Finished response");
  }
  if (labels.length === 0) return undefined;
  const visible = labels.slice(0, 2);
  const hidden = labels.length - visible.length;
  return `${visible.join(" · ")}${hidden > 0 ? ` · +${hidden} more` : ""}`;
}

function receiptLabel(
  category: ActivityCategory,
  events: readonly AgentActivityEvent[],
): string {
  const labels = CATEGORY_LABELS[category];
  if (events.length === 1) return labels.one(events[0]!.label);

  const failed = events.filter((e) => e.state === "failed").length;
  const base = labels.many(events.length);
  return failed > 0
    ? `${base} · ${failed} failed`
    : base;
}

function aggregateState(
  events: readonly AgentActivityEvent[],
): ActivityState {
  if (events.some((e) => e.state === "failed")) return "failed";
  if (events.some((e) => e.state === "pending")) return "pending";
  return "succeeded";
}

function compactReceiptLabel(receipt: ActivityReceipt): string | null {
  const failed = receipt.events.find((event) => event.state === "failed");
  if (failed) return failed.label;

  if (receipt.category === "workspace" || receipt.category === "progress") {
    const concrete = unique(
      receipt.events
        .map((event) => event.label)
        .filter((label) =>
          /^(created|edited|validated|published|uploaded|app .*failed|run failed|run canceled)/i.test(
            label,
          ),
        ),
    );
    if (concrete.length > 0) return concrete.slice(0, 2).join(" · ");
    if (
      receipt.category === "progress" &&
      receipt.events.some((event) => /stored assistant answer/i.test(event.label))
    ) {
      return "Finished response";
    }
    if (receipt.category === "progress") return null;
  }

  return receipt.label;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function firstTimestamp(
  events: readonly AgentActivityEvent[],
): string | null {
  for (const event of events) {
    if (event.at) return event.at;
  }
  return null;
}

/** Fallback for events persisted before categories existed. */
export function inferCategory(label: string): ActivityCategory {
  const lowered = label.toLowerCase();
  if (/vault|context pack|context/.test(lowered)) return "context";
  if (/github/.test(lowered)) return "github";
  if (/workspace|local notes|command|source snippets|supporting facts/.test(lowered)) {
    return "workspace";
  }
  if (
    /worker|queued|provider run|agentcore|run completed|run failed|run canceled|stored assistant|resume|retry/.test(
      lowered,
    )
  ) {
    return "progress";
  }
  return "tools";
}
