import { feedbackReports, getDb } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  adminDataAccessJustification,
  auditAdminDataAccess,
} from "@/lib/admin-data-access";
import { requireAdmin } from "@/lib/auth/requireAdmin";

export const dynamic = "force-dynamic";

const SAFE_SCREENSHOT_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function safeScreenshotMimeType(
  dataUrl: string | null,
  mimeType: string | null,
): string | null {
  if (!dataUrl) return null;
  const match = /^data:([^;,]+);base64,/i.exec(dataUrl);
  const dataUrlMimeType = match?.[1]?.toLowerCase();
  const declaredMimeType = mimeType?.toLowerCase();
  if (!dataUrlMimeType || !SAFE_SCREENSHOT_MIME_TYPES.has(dataUrlMimeType)) {
    return null;
  }
  if (declaredMimeType && declaredMimeType !== dataUrlMimeType) {
    return null;
  }
  return dataUrlMimeType;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const db = getDb();
  const rows = await db
    .select({
      userId: feedbackReports.userId,
      screenshotDataUrl: feedbackReports.screenshotDataUrl,
      screenshotMimeType: feedbackReports.screenshotMimeType,
      screenshotName: feedbackReports.screenshotName,
    })
    .from(feedbackReports)
    .where(eq(feedbackReports.id, id))
    .limit(1);

  const row = rows[0];
  if (!row?.screenshotDataUrl) {
    return NextResponse.json({ error: "screenshot_not_found" }, { status: 404 });
  }

  const mimeType = safeScreenshotMimeType(
    row.screenshotDataUrl,
    row.screenshotMimeType,
  );
  if (!mimeType) {
    return NextResponse.json({ error: "invalid_screenshot" }, { status: 422 });
  }

  await auditAdminDataAccess({
    db,
    actor: auth.user,
    access: {
      targetUserId: row.userId,
      resourceType: "feedback_report",
      resourceId: id,
      surface: "feedback_screenshot",
      justification: adminDataAccessJustification(req),
    },
  });

  return NextResponse.json({
    screenshot: {
      dataUrl: row.screenshotDataUrl,
      mimeType,
      name: row.screenshotName,
    },
  });
}
