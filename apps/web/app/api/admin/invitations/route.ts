import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import {
  createInvitation,
  inviteUrlFor,
  listPendingInvitations,
  normalizeEmail,
} from "@/lib/invitations";

export const dynamic = "force-dynamic";

export interface PendingInvitationDto {
  id: string;
  email: string;
  role: "admin" | "user";
  token: string;
  invitedByName: string;
  invitedByEmail: string;
  createdAt: string;
  expiresAt: string;
  inviteUrl: string;
}

export interface CreateInvitationResponse {
  invitation: PendingInvitationDto;
  inviteUrl: string;
}

interface PostBody {
  email?: unknown;
  role?: unknown;
}

// Loose RFC-5321 sanity check — we're not doing deliverability validation
// here, just rejecting payloads that obviously aren't email shaped so the
// admin gets a meaningful 400 instead of a confusing token mailto link.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const created = await createInvitation({
    email,
    role,
    invitedBy: auth.user.id,
  });
  const inviteUrl = inviteUrlFor(created.token, req.url);

  const dto: PendingInvitationDto = {
    id: created.id,
    email: created.email,
    role: created.role,
    token: created.token,
    invitedByName: auth.user.displayName,
    invitedByEmail: auth.user.email,
    createdAt: created.createdAt.toISOString(),
    expiresAt: created.expiresAt.toISOString(),
    inviteUrl,
  };

  const payload: CreateInvitationResponse = { invitation: dto, inviteUrl };
  return NextResponse.json(payload, { status: 201 });
}

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const rows = await listPendingInvitations();
  const out: PendingInvitationDto[] = rows.map((r) => ({
    id: r.id,
    email: normalizeEmail(r.email),
    role: r.role,
    token: r.token,
    invitedByName: r.invitedByName,
    invitedByEmail: r.invitedByEmail,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    inviteUrl: inviteUrlFor(r.token, req.url),
  }));

  return NextResponse.json({ invitations: out });
}
