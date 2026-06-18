import { chatThreads, feedbackReports, getDb, users } from "@ai-workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { FilterPill } from "@/app/admin/ui";
import {
  FeedbackTable,
  type AdminFeedbackRow,
} from "./FeedbackTable";

export const dynamic = "force-dynamic";

interface Props {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "reviewing", label: "Reviewing" },
  { value: "triaged", label: "Triaged" },
  { value: "fixed", label: "Fixed" },
  { value: "wontfix", label: "Won't fix" },
];

function parseStatus(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return STATUS_FILTERS.some((item) => item.value === raw) ? raw! : "new";
}

export default async function AdminFeedbackPage({ searchParams }: Props) {
  const sessionUser = await getSessionUser();
  if (!sessionUser || sessionUser.role !== "admin") {
    redirect("/chat");
  }

  const params = (await searchParams) ?? {};
  const status = parseStatus(params.status);
  const db = getDb();

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
    .where(status === "all" ? undefined : eq(feedbackReports.status, status))
    .orderBy(desc(feedbackReports.createdAt))
    .limit(100);

  const counts = await db
    .select({
      status: feedbackReports.status,
      count: sql<number>`count(*)::int`,
    })
    .from(feedbackReports)
    .groupBy(feedbackReports.status);
  const countByStatus = new Map(counts.map((row) => [row.status, row.count]));
  const total = counts.reduce((sum, row) => sum + row.count, 0);

  const out: AdminFeedbackRow[] = rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  }));

  return (
    <section className="py-2">
      <div className="px-6 pb-3 pt-4">
        <h2 className="text-base font-semibold text-ink">Feedback</h2>
        <p className="mt-1 text-[12px] text-muted">
          Alpha tester reports with chat context, browser details, and triage state.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 pb-4">
        {STATUS_FILTERS.map((item) => {
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
        <span className="ml-auto text-[12px] text-muted">
          showing {out.length.toLocaleString()} report{out.length === 1 ? "" : "s"}
        </span>
      </div>

      <FeedbackTable rows={out} />
    </section>
  );
}
