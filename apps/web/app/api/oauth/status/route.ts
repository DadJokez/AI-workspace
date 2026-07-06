import { AuthConfigError } from "@ai-workspace/auth";
import { getDb, oauthTokens } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { getMcpProviderExecutionStatus } from "@/lib/oauth/mcp-servers";

export const dynamic = "force-dynamic";

type Provider = "github" | "notion" | "google";
type ProviderConnectionStatus =
  | "not_connected"
  | "ready"
  | "connected_execution_not_configured";

/**
 * GET /api/oauth/status — { github, notion, google } booleans for the caller.
 */
export async function GET() {
  let sessionUser;
  try {
    sessionUser = await getSessionUser();
  } catch (err) {
    if (err instanceof AuthConfigError) {
      return NextResponse.json(
        { error: "auth_config_error", message: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();

  const rows = await db
    .select({ provider: oauthTokens.provider, expiresAt: oauthTokens.expiresAt })
    .from(oauthTokens)
    .where(eq(oauthTokens.userId, sessionUser.id));

  const now = Date.now();
  const connected = new Set(
    rows
      .filter(
        (r) =>
          !r.expiresAt ||
          (r.expiresAt instanceof Date ? r.expiresAt.getTime() : Date.parse(r.expiresAt)) >
            now,
      )
      .map((r) => r.provider),
  );
  const status: Record<Provider, boolean> = {
    github: connected.has("github"),
    notion: connected.has("notion"),
    google: connected.has("google"),
  };

  return NextResponse.json({
    ...status,
    providerDetails: {
      github: providerDetails("github", connected.has("github")),
      notion: providerDetails("notion", connected.has("notion")),
      google: providerDetails("google", connected.has("google")),
    },
  });
}

function providerDetails(provider: Provider, connected: boolean) {
  const execution = getMcpProviderExecutionStatus(provider);
  const toolAvailable = connected && execution.executionConfigured;
  const status: ProviderConnectionStatus = !connected
    ? "not_connected"
    : toolAvailable
      ? "ready"
      : "connected_execution_not_configured";
  return {
    connected,
    executionConfigured: execution.executionConfigured,
    toolAvailable,
    status,
    ...(execution.reason ? { reason: execution.reason } : {}),
  };
}
