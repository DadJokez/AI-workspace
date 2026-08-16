import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { revokeStandingToolApproval } from "@/lib/tool-approvals";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function DELETE(
  _req: Request,
  {
    params,
  }: { params: Promise<{ id: string; approvalId: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const { id: skillId, approvalId } = await params;
  if (!UUID_PATTERN.test(skillId) || !UUID_PATTERN.test(approvalId)) {
    return NextResponse.json(
      { error: "invalid_standing_approval_id" },
      { status: 400 },
    );
  }

  const revoked = await revokeStandingToolApproval({
    db: getDb(),
    userId: session.user.id,
    skillId,
    approvalId,
  });
  if (!revoked) {
    return NextResponse.json(
      { error: "standing_approval_not_found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
