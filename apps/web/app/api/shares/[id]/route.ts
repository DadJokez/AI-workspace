import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { parseAppShareRole, revokeShare, updateShareRole } from "@/lib/shares";

export const dynamic = "force-dynamic";

/** Revoke a share. Recipient clones are unaffected (FR-010). */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const { id } = await params;

  const result = await revokeShare({
    db: getDb(),
    actor: sessionUser,
    shareId: id,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: result.message },
      { status: result.status },
    );
  }
  return NextResponse.json({ ok: true });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const result = await updateShareRole({
    db: getDb(),
    actor: sessionUser,
    shareId: id,
    role: parseAppShareRole((body as Record<string, unknown> | null)?.role),
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: result.message },
      { status: result.status },
    );
  }
  return NextResponse.json({ share: result.share });
}
