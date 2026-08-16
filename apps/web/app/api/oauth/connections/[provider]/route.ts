import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { revokeOAuthConnection } from "@/lib/oauth/connection";
import { SUPPORTED_MCP_PROVIDERS } from "@/lib/oauth/mcp-servers";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;

  const { provider } = await params;
  if (!SUPPORTED_MCP_PROVIDERS.includes(provider)) {
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
