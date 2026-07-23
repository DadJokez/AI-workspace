import type { SessionUser } from "@ai-workspace/auth";
import type { Database } from "@ai-workspace/db";
import { describe, expect, it } from "vitest";
import {
  ADMIN_DATA_ACCESS_ACTION,
  ADMIN_DATA_ACCESS_JUSTIFICATION_HEADER,
  ADMIN_DATA_ACCESS_SCHEMA,
  adminDataAccessJustification,
  auditAdminDataAccess,
  auditAdminDataAccessBatch,
  parseAdminDataAccessMetadata,
} from "@/lib/admin-data-access";

const admin: SessionUser = {
  id: "admin-user",
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin",
};
const user: SessionUser = {
  id: "regular-user",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};
const now = new Date("2026-07-23T12:00:00.000Z");

function mockDb(recentMetadata: unknown[] = []) {
  const inserted: Array<Record<string, unknown>> = [];
  const limits: number[] = [];
  let selectCalls = 0;
  const query = {
    from() {
      return query;
    },
    where() {
      return query;
    },
    limit(value: number) {
      limits.push(value);
      return Promise.resolve(
        recentMetadata.map((metadata) => ({ metadata })),
      );
    },
  };
  const db = {
    select() {
      selectCalls += 1;
      return query;
    },
    insert() {
      return {
        values: async (
          values:
            | Record<string, unknown>
            | Array<Record<string, unknown>>,
        ) => {
          inserted.push(...(Array.isArray(values) ? values : [values]));
        },
      };
    },
  } as unknown as Database;
  return {
    db,
    inserted,
    limits,
    selectCalls: () => selectCalls,
  };
}

describe("admin data access audit", () => {
  it("skips non-admin and same-user reads without touching the ledger", async () => {
    const mocked = mockDb();
    const access = {
      targetUserId: user.id,
      resourceType: "chat_thread",
      resourceId: "thread-1",
      surface: "thread_detail",
    };

    await expect(
      auditAdminDataAccess({
        db: mocked.db,
        actor: user,
        access,
        now,
      }),
    ).resolves.toBe("skipped");
    await expect(
      auditAdminDataAccess({
        db: mocked.db,
        actor: admin,
        access: { ...access, targetUserId: admin.id },
        now,
      }),
    ).resolves.toBe("skipped");

    expect(mocked.selectCalls()).toBe(0);
    expect(mocked.inserted).toHaveLength(0);
  });

  it("records the actor, target user, resource, surface, and justification", async () => {
    const mocked = mockDb();

    await expect(
      auditAdminDataAccess({
        db: mocked.db,
        actor: admin,
        access: {
          targetUserId: user.id,
          resourceType: "run",
          resourceId: "run-1",
          surface: "run_inspector",
          justification: " Incident 42 investigation ",
          runId: "run-1",
        },
        now,
      }),
    ).resolves.toBe("audited");

    expect(mocked.inserted).toEqual([
      expect.objectContaining({
        actorUserId: admin.id,
        actionType: ADMIN_DATA_ACCESS_ACTION,
        status: "succeeded",
        provider: "ai-hub",
        runId: "run-1",
        metadata: {
          schema: ADMIN_DATA_ACCESS_SCHEMA,
          targetUserId: user.id,
          resourceType: "run",
          resourceId: "run-1",
          surface: "run_inspector",
          justification: "Incident 42 investigation",
        },
        startedAt: now,
        completedAt: now,
        createdAt: now,
      }),
    ]);
    expect(mocked.limits).toEqual([1]);
  });

  it("still audits orphaned private resources whose user was deleted", async () => {
    const mocked = mockDb();

    await expect(
      auditAdminDataAccess({
        db: mocked.db,
        actor: admin,
        access: {
          targetUserId: null,
          resourceType: "feedback_report",
          resourceId: "report-1",
          surface: "feedback_screenshot",
        },
        now,
      }),
    ).resolves.toBe("audited");
    expect(mocked.inserted[0]!.metadata).toEqual(
      expect.objectContaining({ targetUserId: "unknown" }),
    );
  });

  it("deduplicates polling for the same actor, target, resource, and surface", async () => {
    const metadata = {
      schema: ADMIN_DATA_ACCESS_SCHEMA,
      targetUserId: user.id,
      resourceType: "run",
      resourceId: "run-1",
      surface: "run_inspector",
    };
    const mocked = mockDb([metadata]);

    await expect(
      auditAdminDataAccess({
        db: mocked.db,
        actor: admin,
        access: metadata,
        now,
      }),
    ).resolves.toBe("deduplicated");
    expect(mocked.inserted).toHaveLength(0);
  });

  it("collapses collection reads per target user and preserves record counts", async () => {
    const mocked = mockDb();
    const result = await auditAdminDataAccessBatch({
      db: mocked.db,
      actor: admin,
      accesses: [
        {
          targetUserId: user.id,
          resourceType: "feedback_collection",
          resourceId: "status:all",
          surface: "admin_feedback",
          resourceCount: 1,
        },
        {
          targetUserId: user.id,
          resourceType: "feedback_collection",
          resourceId: "status:all",
          surface: "admin_feedback",
          resourceCount: 1,
        },
        {
          targetUserId: user.id,
          resourceType: "feedback_collection",
          resourceId: "status:all",
          surface: "admin_feedback",
          resourceCount: 1,
        },
        {
          targetUserId: "second-user",
          resourceType: "feedback_collection",
          resourceId: "status:all",
          surface: "admin_feedback",
          resourceCount: 1,
        },
        {
          targetUserId: admin.id,
          resourceType: "feedback_collection",
          resourceId: "status:all",
          surface: "admin_feedback",
          resourceCount: 1,
        },
      ],
      now,
    });

    expect(result).toEqual({ inserted: 2, deduplicated: 0, skipped: 1 });
    expect(mocked.inserted).toHaveLength(2);
    expect(mocked.inserted[0]!.metadata).toEqual(
      expect.objectContaining({
        targetUserId: user.id,
        resourceCount: 3,
      }),
    );
  });

  it("accepts an optional justification header without putting it in the URL", () => {
    const request = new Request("https://example.com/admin/runs/run-1", {
      headers: {
        [ADMIN_DATA_ACCESS_JUSTIFICATION_HEADER]: "  Support escalation  ",
      },
    });
    expect(adminDataAccessJustification(request)).toBe("Support escalation");
  });

  it("rejects metadata that is not a complete v1 access receipt", () => {
    expect(parseAdminDataAccessMetadata(null)).toBeNull();
    expect(
      parseAdminDataAccessMetadata({
        schema: ADMIN_DATA_ACCESS_SCHEMA,
        targetUserId: user.id,
        resourceType: "run",
      }),
    ).toBeNull();
  });
});
