import { getDb, orgInstructions } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import {
  parseOrgInstructionContent,
  serializeOrgInstruction,
} from "@/lib/org-instructions";

export const dynamic = "force-dynamic";

interface PatchBody {
  action?: "edit" | "archive";
  content?: unknown;
}

/**
 * Admin-only edit/archive of one approved organization instruction (#438).
 * Archive, never delete: the row stays for the audit trail. An edit moves
 * `authored_by` to the editing admin — attribution follows whoever last
 * wrote the text, which is who a protected-key conflict should name.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const admin = await requireAdmin();
  if ("error" in admin) return admin.error;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const now = new Date();
  let value: Partial<typeof orgInstructions.$inferInsert>;
  if (body.action === "edit") {
    const content = parseOrgInstructionContent(body.content);
    if (!content) {
      return NextResponse.json({ error: "invalid_content" }, { status: 400 });
    }
    value = { content, authoredBy: admin.user.id, updatedAt: now };
  } else if (body.action === "archive") {
    value = { status: "archived", updatedAt: now };
  } else {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const rows = await getDb()
    .update(orgInstructions)
    .set(value)
    .where(
      and(eq(orgInstructions.id, id), eq(orgInstructions.status, "approved")),
    )
    .returning();
  const item = rows[0];
  if (!item) {
    return NextResponse.json(
      { error: "org_instruction_not_found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ item: serializeOrgInstruction(item) });
}
