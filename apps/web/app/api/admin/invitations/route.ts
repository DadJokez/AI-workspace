import { randomBytes } from "node:crypto";
import { getDb, invitations } from "@ai-workspace/db";
import { and, desc, gt, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireAdmin";

export const dynamic = "force-dynamic";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AdminInvitationRow {
  id: string;
  email: string;
  role: "admin" | "user";
  inviteUrl: string;
  expiresAt: string;
  createdAt: string;
}

interface PostBody {
  email?: string;
  role?: "admin" | "user";
}

function inviteUrl(token: string): string {
  const base = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  return `${base.replace(/\/+$/, "")}/invite/${token}`;
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

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  const role: "admin" | "user" = body.role === "admin" ? "admin" : "user";

  // 32 random bytes → 64 hex chars. Hex (not base64url) so the token survives
  // any URL encoding/casing weirdness without escaping.
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
      token: invitations.token,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    });

  const row = inserted[0]!;
  const out: AdminInvitationRow = {
    id: row.id,
    email: row.email,
    role: row.role,
    inviteUrl: inviteUrl(row.token),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
  return NextResponse.json({ invitation: out }, { status: 201 });
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
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .where(
      and(isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date())),
    )
    .orderBy(desc(invitations.createdAt));

  const out: AdminInvitationRow[] = rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    inviteUrl: inviteUrl(r.token),
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  }));
  return NextResponse.json({ invitations: out });
}
