import { getDb, invitations, users } from "@ai-workspace/db";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import {
  expiresAtFromNow,
  generateInvitationToken,
} from "@/lib/invitations";

export const dynamic = "force-dynamic";

export interface AdminInvitationRow {
  id: string;
  email: string;
  role: "admin" | "user";
  invitedByEmail: string | null;
  expiresAt: string;
  createdAt: string;
}

interface PostBody {
  email?: unknown;
  role?: unknown;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function buildInviteUrl(req: Request, token: string): string {
  // Prefer the X-Forwarded-* headers our proxy sets, then fall back to the
  // request URL's origin. This produces a publicly-routable link in prod
  // (where the request hits the proxy) without hard-coding a base URL.
  const xfHost = req.headers.get("x-forwarded-host");
  const xfProto = req.headers.get("x-forwarded-proto");
  if (xfHost) {
    const proto = xfProto ?? "https";
    return `${proto}://${xfHost}/invite/${token}`;
  }
  const origin = new URL(req.url).origin;
  return `${origin}/invite/${token}`;
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

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  const role = body.role;
  if (role !== "admin" && role !== "user") {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  const token = generateInvitationToken();
  const expiresAt = expiresAtFromNow();

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
    .returning();

  const row = inserted[0]!;
  return NextResponse.json({
    invitation: {
      id: row.id,
      email: row.email,
      role: row.role,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    },
    inviteUrl: buildInviteUrl(req, token),
  });
}

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const db = getDb();
  const now = new Date();
  // Left-join the inviter's user row so the admin UI can show "invited by
  // alice@…" without a second round-trip. The cascade-on-delete on
  // `invited_by` makes the join target stable for any pending row.
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
      invitedByEmail: users.email,
    })
    .from(invitations)
    .leftJoin(users, eq(users.id, invitations.invitedBy))
    .where(
      and(isNull(invitations.acceptedAt), gt(invitations.expiresAt, now)),
    )
    .orderBy(desc(invitations.createdAt));

  const out: AdminInvitationRow[] = rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    invitedByEmail: r.invitedByEmail,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  }));

  return NextResponse.json({ invitations: out });
}
