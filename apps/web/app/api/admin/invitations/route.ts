import { randomBytes } from "node:crypto";
import { getDb, invitations, users } from "@ai-workspace/db";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import {
  type AdminInvitationRow,
  EMAIL_RE,
  INVITE_TTL_MS,
  buildInviteUrl,
} from "@/lib/invitations";

export const dynamic = "force-dynamic";

export type { AdminInvitationRow };

interface PostBody {
  email?: unknown;
  role?: unknown;
}

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const role = body.role;
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  if (role !== "admin" && role !== "user") {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const db = getDb();
  const inserted = await db
    .insert(invitations)
    .values({
      email,
      role,
      token,
      invitedBy: auth.user.id,
      expiresAt,
    })
    .returning({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      invitedBy: invitations.invitedBy,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
      token: invitations.token,
    });

  const row = inserted[0]!;
  const inviteUrl = buildInviteUrl(row.token);
  const out: AdminInvitationRow = {
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: row.invitedBy,
    invitedByEmail: auth.user.email,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    inviteUrl,
  };

  return NextResponse.json({ inviteUrl, invitation: out }, { status: 201 });
}

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const db = getDb();
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      token: invitations.token,
      invitedBy: invitations.invitedBy,
      invitedByEmail: users.email,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .leftJoin(users, eq(users.id, invitations.invitedBy))
    .where(
      and(
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(invitations.createdAt));

  const out: AdminInvitationRow[] = rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    invitedBy: r.invitedBy,
    invitedByEmail: r.invitedByEmail,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    inviteUrl: buildInviteUrl(r.token),
  }));

  return NextResponse.json({ invitations: out });
}
