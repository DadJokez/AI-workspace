import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import {
  getMcpProviderExecutionStatus,
  loadUserMcpProviderStatus,
  SUPPORTED_MCP_PROVIDERS,
} from "@/lib/oauth/mcp-servers";

export const dynamic = "force-dynamic";

type ProviderConnectionStatus =
  | "not_connected"
  | "ready"
  | "connector_disabled"
  | "pending_approval"
  | "reconnect_required"
  | "temporarily_unavailable"
  | "connected_execution_not_configured";

/**
 * GET /api/oauth/status — per-provider connection booleans for the caller,
 * for the connectors this deployment offers. A provider the deployment has
 * turned off is absent from both maps.
 */
export async function GET() {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  const db = getDb();

  const providerStatus = await loadUserMcpProviderStatus(db, sessionUser.id);
  const details = Object.fromEntries(
    SUPPORTED_MCP_PROVIDERS.map((provider) => [
      provider,
      providerDetails(provider, providerStatus.providerAvailability?.[provider]),
    ]),
  );
  const status = Object.fromEntries(
    SUPPORTED_MCP_PROVIDERS.map((provider) => [
      provider,
      details[provider]!.connected,
    ]),
  );

  return NextResponse.json({
    ...status,
    providerDetails: details,
  });
}

function providerDetails(
  provider: string,
  availability:
    | NonNullable<
        Awaited<ReturnType<typeof loadUserMcpProviderStatus>>["providerAvailability"]
      >[string]
    | undefined,
) {
  const execution = getMcpProviderExecutionStatus(provider);
  const connected = availability?.connected === true;
  const toolAvailable = availability?.modelAvailable === true;
  const status: ProviderConnectionStatus = !connected
    ? "not_connected"
    : toolAvailable
      ? "ready"
      : availability?.status === "connector_disabled"
        ? "connector_disabled"
        : availability?.status === "reconnect_required"
        ? "reconnect_required"
        : availability?.status === "temporarily_unavailable"
          ? "temporarily_unavailable"
          : availability?.status === "pending_approval"
            ? "pending_approval"
      : "connected_execution_not_configured";
  return {
    connected,
    executionConfigured: execution.executionConfigured,
    toolAvailable,
    status,
    ...(availability?.reason
      ? { reason: availability.reason }
      : execution.reason
        ? { reason: execution.reason }
        : {}),
  };
}
