import type { Database } from "@ai-workspace/db";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("OAuth connection lifecycle", () => {
  it("scrubs token material, revokes grants, and emits actor/reason events", async () => {
    vi.stubEnv(
      "OAUTH_ENCRYPTION_KEY",
      Buffer.alloc(32, 4).toString("base64"),
    );
    const updates: Array<Record<string, unknown>> = [];
    const auditRows: Array<Record<string, unknown>> = [];
    let updateCount = 0;
    const tx = {
      update: () => ({
        set: (value: Record<string, unknown>) => {
          updates.push(value);
          const index = updateCount++;
          return {
            where: () => ({
              returning: async () =>
                index === 0
                  ? [{ id: "connection-1" }]
                  : [
                      {
                        id: "attestation-1",
                        scopeType: "provider",
                        category: null,
                        toolName: null,
                        action: "admin",
                      },
                    ],
            }),
          };
        },
      }),
      insert: () => ({
        values: async (
          rows: Record<string, unknown> | Array<Record<string, unknown>>,
        ) => auditRows.push(...(Array.isArray(rows) ? rows : [rows])),
      }),
    };
    const db = {
      transaction: async <T>(callback: (value: typeof tx) => Promise<T>) =>
        callback(tx),
    } as unknown as Database;
    const now = new Date("2026-08-15T20:00:00.000Z");
    const { revokeOAuthConnection } = await import("@/lib/oauth/connection");

    const result = await revokeOAuthConnection({
      db,
      userId: "00000000-0000-4000-8000-000000000420",
      provider: "github",
      actorUserId: "00000000-0000-4000-8000-000000000421",
      reason: "  User requested disconnect  ",
      source: "unit.test",
      now,
    });

    expect(result).toEqual({ revoked: true, attestations: 1 });
    expect(updates[0]).toMatchObject({
      refreshToken: null,
      expiresAt: now,
      revokedAt: now,
      revokedBy: "00000000-0000-4000-8000-000000000421",
      revocationReason: "User requested disconnect",
    });
    expect(updates[0]!.accessToken).toEqual(expect.any(String));
    expect(updates[0]!.accessToken).not.toContain("User requested disconnect");
    expect(updates[1]).toMatchObject({
      revokedAt: now,
      revokedBy: "00000000-0000-4000-8000-000000000421",
      revocationReason: "User requested disconnect",
    });
    expect(auditRows).toEqual([
      expect.objectContaining({
        actionType: "connection.revoked",
        provider: "github",
        metadata: {
          reason: "User requested disconnect",
          source: "unit.test",
        },
      }),
      expect.objectContaining({
        actionType: "attestation.revoked",
        provider: "github",
        metadata: expect.objectContaining({
          reason: "User requested disconnect",
          scopeType: "provider",
        }),
      }),
    ]);
  });
});
