import { getDb, oauthTokens, userToolAttestations } from "@ai-workspace/db";
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
    })
    .onConflictDoUpdate({
      target: [oauthTokens.userId, oauthTokens.provider],
      set: {
        accessToken: accessTokenEnc,
        refreshToken: refreshTokenEnc,
        expiresAt,
        scope,
        updatedAt: sql`now()`,
      },
    });

  const existingAttestation = await db
    .select({ id: userToolAttestations.id })
    .from(userToolAttestations)
    .where(
      and(
        eq(userToolAttestations.userId, userId),
        eq(userToolAttestations.scopeType, "provider"),
        eq(userToolAttestations.provider, provider),
        isNull(userToolAttestations.revokedAt),
      ),
    )
    .limit(1);

  if (!existingAttestation[0]) {
    await db.insert(userToolAttestations).values({
      userId,
      scopeType: "provider",
      provider,
      action: "admin",
      approvedBy: userId,
      reason: attestationReason,
      metadata: { source: attestationSource },
    });
  }
}
