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
  const now = new Date();
  const accessTokenEnc = encryptSecret(accessToken);
  const refreshTokenEnc = refreshToken ? encryptSecret(refreshToken) : null;

  return db.transaction(async (tx) => {
    const connection = await tx
      .insert(oauthTokens)
      .values({
        userId,
        provider,
        accessToken: accessTokenEnc,
        refreshToken: refreshTokenEnc,
        expiresAt,
        scope,
        providerMetadata,
        grantedAt: now,
      })
      .onConflictDoUpdate({
        target: [oauthTokens.userId, oauthTokens.provider],
        set: {
          accessToken: accessTokenEnc,
          ...(refreshTokenEnc ? { refreshToken: refreshTokenEnc } : {}),
          expiresAt,
          scope,
          ...(providerMetadata ? { providerMetadata } : {}),
          grantedAt: now,
          revokedAt: null,
          revokedBy: null,
          revocationReason: null,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: oauthTokens.id });

    const existingAttestations = await tx
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
    let attestationId: string | null = null;
    if (!alreadyCovered) {
      const inserted = await tx
        .insert(userToolAttestations)
        .values({
          userId,
          scopeType: "provider",
          provider,
          action: attestationAction,
          approvedBy: userId,
          reason: attestationReason,
          metadata: { source: attestationSource },
        })
        .returning({ id: userToolAttestations.id });
      attestationId = inserted[0]?.id ?? null;
    }

    // This centralized callback write path is the connection lifecycle source
    // of truth. Token material is intentionally excluded from every audit row.
    await tx.insert(auditLog).values([
      {
        actorUserId: userId,
        actionType: "connection.granted",
        status: "succeeded",
        provider,
        toolName: "oauth_connection",
        input: { userId, connectionId: connection[0]?.id ?? null },
        metadata: { scope, source: attestationSource },
        startedAt: now,
        completedAt: now,
      },
      ...(attestationId
        ? [
            {
              actorUserId: userId,
              actionType: "attestation.granted",
              status: "succeeded" as const,
              provider,
              toolName: "provider_attestation",
              input: { userId, attestationId },
              metadata: {
                scopeType: "provider",
                action: attestationAction,
                reason: attestationReason,
                source: attestationSource,
              },
              startedAt: now,
              completedAt: now,
            },
          ]
        : []),
    ]);

    return {
      connectionId: connection[0]?.id ?? null,
      attestationId,
    };
  });
}

export interface RevokeOAuthConnectionInput {
  db?: Database;
  userId: string;
  provider: string;
  actorUserId: string;
  reason: string;
  source: string;
  now?: Date;
}

/** Revoke and scrub one delegated connection plus every active grant for it. */
export async function revokeOAuthConnection({
  db = getDb(),
  userId,
  provider,
  actorUserId,
  reason,
  source,
  now = new Date(),
}: RevokeOAuthConnectionInput) {
  const normalizedReason = normalizeReason(reason);
  const scrubbedAccessToken = encryptSecret(`revoked:${now.toISOString()}`);

  return db.transaction(async (tx) => {
    const revokedConnections = await tx
      .update(oauthTokens)
      .set({
        accessToken: scrubbedAccessToken,
        refreshToken: null,
        expiresAt: now,
        revokedAt: now,
        revokedBy: actorUserId,
        revocationReason: normalizedReason,
        updatedAt: now,
      })
      .where(
        and(
          eq(oauthTokens.userId, userId),
          eq(oauthTokens.provider, provider),
          isNull(oauthTokens.revokedAt),
        ),
      )
      .returning({ id: oauthTokens.id });

    if (!revokedConnections[0]) return { revoked: false, attestations: 0 };

    const revokedAttestations = await tx
      .update(userToolAttestations)
      .set({
        revokedAt: now,
        revokedBy: actorUserId,
        revocationReason: normalizedReason,
        updatedAt: now,
      })
      .where(
        and(
          eq(userToolAttestations.userId, userId),
          eq(userToolAttestations.provider, provider),
          isNull(userToolAttestations.revokedAt),
        ),
      )
      .returning({
        id: userToolAttestations.id,
        scopeType: userToolAttestations.scopeType,
        category: userToolAttestations.category,
        toolName: userToolAttestations.toolName,
        action: userToolAttestations.action,
      });

    await tx.insert(auditLog).values([
      {
        actorUserId,
        actionType: "connection.revoked",
        status: "succeeded",
        provider,
        toolName: "oauth_connection",
        input: {
          userId,
          connectionId: revokedConnections[0].id,
        },
        metadata: { reason: normalizedReason, source },
        startedAt: now,
        completedAt: now,
      },
      ...revokedAttestations.map((attestation) => ({
        actorUserId,
        actionType: "attestation.revoked" as const,
        status: "succeeded" as const,
        provider,
        toolName: "provider_attestation",
        input: { userId, attestationId: attestation.id },
        metadata: {
          reason: normalizedReason,
          source,
          scopeType: attestation.scopeType,
          category: attestation.category,
          nativeToolName: attestation.toolName,
          action: attestation.action,
        },
        startedAt: now,
        completedAt: now,
      })),
    ]);

    return { revoked: true, attestations: revokedAttestations.length };
  });
}

function normalizeReason(reason: string): string {
  const normalized = reason.trim().replace(/\s+/g, " ").slice(0, 500);
  return normalized || "No reason provided";
}

function actionRank(action: "read" | "write" | "admin"): number {
  return { read: 1, write: 2, admin: 3 }[action];
}
