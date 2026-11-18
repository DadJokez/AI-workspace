import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { CONNECTOR_PROVIDERS } from "@/lib/deployment-config";
import { revokeOAuthConnection } from "@/lib/oauth/connection";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;

  const { provider } = await params;
  // Any known connector, enabled or not: a user can always revoke a grant
  // they gave, including one for a connector this deployment has turned off.
  if (!(CONNECTOR_PROVIDERS as readonly string[]).includes(provider)) {
    return NextResponse.json({ error: "unsupported_provider" }, { status: 400 });
  }

  const result = await revokeOAuthConnection({
    userId: session.user.id,
    provider,
    actorUserId: session.user.id,
    reason: "Disconnected by the account owner",
    source: "settings.integrations",
  });
  if (!result.revoked) {
    return NextResponse.json({ error: "connection_not_found" }, { status: 404 });
  }
  return NextResponse.json({ provider, ...result });
}
