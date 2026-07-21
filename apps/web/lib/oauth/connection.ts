import {
  auditLog,
  getDb,
  oauthTokens,
  userToolAttestations,
} from "@ai-workspace/db";
import type { Database } from "@ai-workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { encryptSecret } from "@/lib/oauth/crypto";

export interface StoreOAuthConnectionInput {
  db?: Database;
  userId: string;
  provider: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scope?: string | null;
  /** Provider-specific connection metadata (e.g. Salesforce instance_url). */
  providerMetadata?: Record<string, unknown> | null;
  attestationAction?: "read" | "write" | "admin";
  attestationReason: string;
  attestationSource: string;
}

export async function storeOAuthConnection({
  db = getDb(),
  userId,
  provider,
  accessToken,
  refreshToken = null,
  expiresAt = null,
  scope = null,
  providerMetadata = null,
  attestationAction = "admin",
  attestationReason,
  attestationSource,
}: StoreOAuthConnectionInput) {
  const accessTokenEnc = encryptSecret(accessToken);
  const refreshTokenEnc = refreshToken ? encryptSecret(refreshToken) : null;

  await db
    .insert(oauthTokens)
    .values({
      userId,
      provider,
      accessToken: accessTokenEnc,
      refreshToken: refreshTokenEnc,
      expiresAt,
      scope,
      providerMetadata,
    })
    .onConflictDoUpdate({
      target: [oauthTokens.userId, oauthTokens.provider],
      set: {
        accessToken: accessTokenEnc,
        ...(refreshTokenEnc ? { refreshToken: refreshTokenEnc } : {}),
        expiresAt,
        scope,
        ...(providerMetadata ? { providerMetadata } : {}),
        updatedAt: sql`now()`,
      },
    });

  const existingAttestations = await db
    .select({
      id: userToolAttestations.id,
      action: userToolAttestations.action,
    })
    .from(userToolAttestations)
    .where(
      and(
        eq(userToolAttestations.userId, userId),
        eq(userToolAttestations.scopeType, "provider"),
        eq(userToolAttestations.provider, provider),
        isNull(userToolAttestations.revokedAt),
      ),
    )
    .limit(100);

  const alreadyCovered = existingAttestations.some(
    ({ action }) => actionRank(action) >= actionRank(attestationAction),
  );
  if (!alreadyCovered) {
    await db.insert(userToolAttestations).values({
      userId,
      scopeType: "provider",
      provider,
      action: attestationAction,
      approvedBy: userId,
      reason: attestationReason,
      metadata: { source: attestationSource },
    });
  }

  // #456: connecting a provider grants the assistant standing access to
  // external data — auditable by construction here, the one write path every
  // OAuth callback uses. No token material goes anywhere near the row.
  const now = new Date();
  await db.insert(auditLog).values({
    actorUserId: userId,
    actionType: "mcp_connection_create",
    status: "succeeded",
    provider,
    toolName: "mcp_connection_create",
    input: { attestationAction, attestationSource },
    metadata: { scope, attestationReason },
    startedAt: now,
    completedAt: now,
  });
}

function actionRank(action: "read" | "write" | "admin"): number {
  return { read: 1, write: 2, admin: 3 }[action];
}
