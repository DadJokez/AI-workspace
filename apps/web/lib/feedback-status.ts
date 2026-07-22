export const FEEDBACK_STATUS_OPTIONS = [
  { value: "new", label: "New" },
  { value: "reviewing", label: "Reviewing" },
  { value: "triaged", label: "Triaged" },
  { value: "fixed", label: "Fixed" },
  { value: "wontfix", label: "Won't fix" },
] as const;

export const FEEDBACK_STATUS_FILTERS = [
  { value: "all", label: "All" },
  ...FEEDBACK_STATUS_OPTIONS,
] as const;

export type FeedbackStatusFilter =
  (typeof FEEDBACK_STATUS_FILTERS)[number]["value"];

export function parseFeedbackStatusFilter(
  value: string | string[] | undefined,
): FeedbackStatusFilter {
  const raw = Array.isArray(value) ? value[0] : value;
  return FEEDBACK_STATUS_FILTERS.some((item) => item.value === raw)
    ? (raw as FeedbackStatusFilter)
    : "new";
}

export function normalizeFeedbackStatus(status: string): string {
  return status === "resolved" ? "fixed" : status;
}

export function summarizeFeedbackStatusCounts(
  counts: Array<{ status: string; count: number }>,
): { countByStatus: Map<string, number>; total: number } {
  const countByStatus = new Map<string, number>();
  let total = 0;

  for (const row of counts) {
    const status = normalizeFeedbackStatus(row.status);
    countByStatus.set(status, (countByStatus.get(status) ?? 0) + row.count);
    total += row.count;
  }

  return { countByStatus, total };
}
