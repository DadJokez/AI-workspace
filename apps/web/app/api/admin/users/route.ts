import { getDb, users, type UserStatus } from "@ai-workspace/db";
import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireAdmin";

export const dynamic = "force-dynamic";

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
  status: UserStatus;
  statusChangedAt: string | null;
  statusReason: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      status: users.status,
      statusChangedAt: users.statusChangedAt,
      statusReason: users.statusReason,
      createdAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt));

  const out: AdminUserRow[] = rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    role: r.role,
    status: r.status,
    statusChangedAt: r.statusChangedAt?.toISOString() ?? null,
    statusReason: r.statusReason,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
  }));

  return NextResponse.json({ users: out });
}
