import { chatThreads, feedbackReports, getDb, users } from "@ai-workspace/db";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { FilterPill } from "@/app/admin/ui";
import {
  FeedbackTable,
  type AdminFeedbackRow,
} from "./FeedbackTable";
import {
  FEEDBACK_STATUS_FILTERS,
  normalizeFeedbackStatus,
  parseFeedbackStatusFilter,
  summarizeFeedbackStatusCounts,
} from "@/lib/feedback-status";

export const dynamic = "force-dynamic";

interface Props {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminFeedbackPage({ searchParams }: Props) {
  const sessionUser = await getSessionUser();
  if (!sessionUser || sessionUser.role !== "admin") {
    redirect("/chat");
  }

  const params = (await searchParams) ?? {};
  const status = parseFeedbackStatusFilter(params.status);
  const db = getDb();
  const statusCondition =
    status === "all"
      ? undefined
      : status === "fixed"
        ? inArray(feedbackReports.status, ["fixed", "resolved"])
        : eq(feedbackReports.status, status);

  const rows = await db
    .select({
      id: feedbackReports.id,
      userEmail: users.email,
      userName: users.displayName,
      threadTitle: chatThreads.title,
      type: feedbackReports.type,
      severity: feedbackReports.severity,
      status: feedbackReports.status,
      title: feedbackReports.title,
      body: feedbackReports.body,
      expected: feedbackReports.expected,
      pageUrl: feedbackReports.pageUrl,
      userAgent: feedbackReports.userAgent,
      screenshotName: feedbackReports.screenshotName,
      screenshotMimeType: feedbackReports.screenshotMimeType,
      linkedIssueUrl: feedbackReports.linkedIssueUrl,
      adminNotes: feedbackReports.adminNotes,
      createdAt: feedbackReports.createdAt,
      updatedAt: feedbackReports.updatedAt,
      resolvedAt: feedbackReports.resolvedAt,
    })
    .from(feedbackReports)
    .leftJoin(users, eq(feedbackReports.userId, users.id))
    .leftJoin(chatThreads, eq(feedbackReports.threadId, chatThreads.id))
    .where(statusCondition)
    .orderBy(desc(feedbackReports.createdAt))
    .limit(100);

  const counts = await db
    .select({
      status: feedbackReports.status,
      count: sql<number>`count(*)::int`,
    })
    .from(feedbackReports)
    .groupBy(feedbackReports.status);
  const { countByStatus, total } = summarizeFeedbackStatusCounts(counts);

  const out: AdminFeedbackRow[] = rows.map((row) => ({
    ...row,
    status: normalizeFeedbackStatus(row.status),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  }));

  return (
    <section className="py-2">
      <div className="px-4 pb-3 pt-4 sm:px-6">
        <h2 className="text-base font-semibold text-ink">Feedback</h2>
        <p className="mt-1 text-xs text-muted">
          Alpha tester reports with chat context, browser details, and triage state.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 pb-4 sm:px-6">
        {FEEDBACK_STATUS_FILTERS.map((item) => {
          const count =
            item.value === "all" ? total : (countByStatus.get(item.value) ?? 0);
          const href =
            item.value === "new"
              ? "/admin/feedback"
              : `/admin/feedback?status=${item.value}`;
          return (
            <FilterPill key={item.value} href={href} active={status === item.value}>
              {item.label} {count > 0 ? `(${count})` : ""}
            </FilterPill>
          );
        })}
        <span className="w-full text-xs text-muted sm:ml-auto sm:w-auto">
          showing {out.length.toLocaleString()} report{out.length === 1 ? "" : "s"}
        </span>
      </div>

      <FeedbackTable key={status} rows={out} />
    </section>
  );
}
