import { getDb, oauthTokens } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { revokeOAuthConnection } from "@/lib/oauth/connection";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const body = await readJson(req);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 3 || reason.length > 500) {
    return NextResponse.json(
      { error: "invalid_reason", message: "Give a brief revocation reason." },
      { status: 400 },
    );
  }

  const db = getDb();
  const rows = await db
    .select({
      userId: oauthTokens.userId,
      provider: oauthTokens.provider,
    })
    .from(oauthTokens)
    .where(eq(oauthTokens.id, id))
    .limit(1);
  const connection = rows[0];
  if (!connection) {
    return NextResponse.json({ error: "connection_not_found" }, { status: 404 });
  }

  const result = await revokeOAuthConnection({
    db,
    userId: connection.userId,
    provider: connection.provider,
    actorUserId: auth.user.id,
    reason,
    source: "admin.connectors",
  });
  if (!result.revoked) {
    return NextResponse.json({ error: "connection_not_active" }, { status: 409 });
  }
  return NextResponse.json({ connectionId: id, ...result });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
