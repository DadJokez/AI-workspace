import { randomBytes } from "node:crypto";
import { getDb, invitations } from "@ai-workspace/db";
import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  INVITE_TTL_MS,
  adminInvitationSelect,
  auditInvitationEvent,
  inviteEmailRateLimit,
  sendAndRecordInvitationEmail,
  toAdminInvitationRow,
  type AdminInvitationRow,
} from "@/lib/admin-invitations";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { checkRateLimit } from "@/lib/request-limits";

export const dynamic = "force-dynamic";

interface PostBody {
  email?: string;
  role?: "admin" | "user";
}

export async function POST(req: Request) {
  const auth = await requireAdmin();
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
  const db = getDb();
  const rate = await checkRateLimit(
    db,
    `invite-email:${auth.user.id}`,
    inviteEmailRateLimit,
  );
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many invitation emails. Please wait and try again.",
        retryAfterSeconds: rate.retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rate.retryAfterSeconds),
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": String(rate.remaining),
          "X-RateLimit-Reset": rate.resetAt.toISOString(),
        },
      },
    );
  }

  // 32 random bytes → 64 hex chars. Hex (not base64url) so the token survives
  // any URL encoding/casing weirdness without escaping.
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const inserted = await db
    .insert(invitations)
    .values({
      email,
      role,
      token,
      invitedBy: auth.user.id,
      expiresAt,
    })
    .returning(adminInvitationSelect);

  const row = inserted[0]!;
  await auditInvitationEvent({
    db,
    actorUserId: auth.user.id,
    invitation: row,
    actionType: "invite.create",
    status: "succeeded",
    metadata: { expiresAt: row.expiresAt.toISOString() },
  });
  const result = await sendAndRecordInvitationEmail({
    db,
    actor: auth.user,
    invitation: row,
    actionType: "invite.send",
  });
  return NextResponse.json(result, { status: 201 });
}

export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const db = getDb();
  const rows = await db
    .select(adminInvitationSelect)
    .from(invitations)
    .orderBy(desc(invitations.createdAt))
    .limit(100);

  const out: AdminInvitationRow[] = rows.map((r) => toAdminInvitationRow(r));
  return NextResponse.json({ invitations: out });
}
