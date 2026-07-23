import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import {
  getMcpProviderExecutionStatus,
  loadUserMcpProviderStatus,
} from "@/lib/oauth/mcp-servers";

export const dynamic = "force-dynamic";

type Provider = "github" | "notion" | "google" | "salesforce";
type ProviderConnectionStatus =
  | "not_connected"
  | "ready"
  | "pending_approval"
  | "reconnect_required"
  | "temporarily_unavailable"
  | "connected_execution_not_configured";

/**
 * GET /api/oauth/status — per-provider connection booleans for the caller.
 */
export async function GET() {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  const db = getDb();

  const providerStatus = await loadUserMcpProviderStatus(db, sessionUser.id);
  const details = {
    github: providerDetails("github", providerStatus.providerAvailability?.github),
    notion: providerDetails("notion", providerStatus.providerAvailability?.notion),
    google: providerDetails("google", providerStatus.providerAvailability?.google),
    salesforce: providerDetails(
      "salesforce",
      providerStatus.providerAvailability?.salesforce,
    ),
  };
  const status: Record<Provider, boolean> = {
    github: details.github.connected,
    notion: details.notion.connected,
    google: details.google.connected,
    salesforce: details.salesforce.connected,
  };

  return NextResponse.json({
    ...status,
    providerDetails: details,
  });
}

function providerDetails(
  provider: Provider,
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
