import { getDb, users } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireAdmin";

export const dynamic = "force-dynamic";

interface PatchBody {
  role?: "admin" | "user";
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const { id } = await params;

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (body.role !== "admin" && body.role !== "user") {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  // Self-demotion lockout: an admin must not be able to remove their own
  // admin role — that's how a workspace ends up with zero admins and no way
  // to recover without a DB-level fix.
  if (auth.user.id === id && body.role !== "admin") {
    return NextResponse.json(
      { error: "cannot_demote_self" },
      { status: 400 },
    );
  }

  const db = getDb();
  const updated = await db
    .update(users)
    .set({ role: body.role })
    .where(eq(users.id, id))
    .returning({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      createdAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
    });

  if (updated.length === 0) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }

  const row = updated[0]!;
  return NextResponse.json({
    user: {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      role: row.role,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    },
  });
}
