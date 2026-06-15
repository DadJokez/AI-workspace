import { feedbackReports, getDb } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireAdmin";

export const dynamic = "force-dynamic";

const STATUSES = new Set(["new", "reviewing", "fixed", "wontfix"]);

interface PatchBody {
  status?: unknown;
  adminNotes?: unknown;
  linkedIssueUrl?: unknown;
}

function cleanString(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const patch: Partial<typeof feedbackReports.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (typeof body.status === "string") {
    if (!STATUSES.has(body.status)) {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
    patch.status = body.status;
    patch.resolvedAt =
      body.status === "fixed" || body.status === "wontfix"
        ? new Date()
        : null;
  }

  const adminNotes = cleanString(body.adminNotes, 4000);
  if (adminNotes !== undefined) patch.adminNotes = adminNotes;

  const linkedIssueUrl = cleanString(body.linkedIssueUrl, 1000);
  if (linkedIssueUrl !== undefined) patch.linkedIssueUrl = linkedIssueUrl;

  const { id } = await params;
  const db = getDb();
  const updated = await db
    .update(feedbackReports)
    .set(patch)
    .where(eq(feedbackReports.id, id))
    .returning({
      id: feedbackReports.id,
      status: feedbackReports.status,
      adminNotes: feedbackReports.adminNotes,
      linkedIssueUrl: feedbackReports.linkedIssueUrl,
      resolvedAt: feedbackReports.resolvedAt,
      updatedAt: feedbackReports.updatedAt,
    });

  const row = updated[0];
  if (!row) {
    return NextResponse.json({ error: "feedback_not_found" }, { status: 404 });
  }

  return NextResponse.json({
    report: {
      ...row,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    },
  });
}
