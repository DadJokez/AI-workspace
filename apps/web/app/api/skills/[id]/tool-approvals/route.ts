import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { listStandingToolApprovals } from "@/lib/tool-approvals";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const { id: skillId } = await params;
  if (!UUID_PATTERN.test(skillId)) {
    return NextResponse.json({ error: "invalid_skill_id" }, { status: 400 });
  }

  const approvals = await listStandingToolApprovals({
    db: getDb(),
    userId: session.user.id,
    skillId,
  });
  return NextResponse.json({ approvals });
}
