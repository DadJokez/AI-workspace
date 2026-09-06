import { getDb, orgInstructions } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { requireSession } from "@/lib/auth/requireSession";
import {
  buildOrgInstructionsMarkdown,
  loadApprovedOrgInstructionRows,
  parseOrgInstructionContent,
  serializeOrgInstruction,
} from "@/lib/org-instructions";

export const dynamic = "force-dynamic";

/**
 * Organization standing instructions (#438). Everyone reads the approved
 * document — transparency is the point of the layer; only admins write it
 * (the existing `requireAdmin` gate). A write lands `approved` at once: the
 * admin is the author and the reviewer, and no model-authored path exists.
 */
export async function GET() {
  const session = await requireSession();
  if ("error" in session) return session.error;

  const rows = await loadApprovedOrgInstructionRows(getDb());
  return NextResponse.json({
    approvedMarkdown: buildOrgInstructionsMarkdown(rows),
    items: rows.map(serializeOrgInstruction),
    canEdit: session.user.role === "admin",
  });
}

export async function POST(req: Request) {
  const admin = await requireAdmin();
  if ("error" in admin) return admin.error;

  let body: { content?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const content = parseOrgInstructionContent(body.content);
  if (!content) {
    return NextResponse.json({ error: "invalid_content" }, { status: 400 });
  }

  const rows = await getDb()
    .insert(orgInstructions)
    .values({ content, status: "approved", authoredBy: admin.user.id })
    .returning();
  return NextResponse.json(
    { item: serializeOrgInstruction(rows[0]!) },
    { status: 201 },
  );
}
