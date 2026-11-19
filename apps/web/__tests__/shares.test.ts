import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

/**
 * Share-aware access tests (specs/002-skills-spine T403): a share grants
 * visibility/run to the recipient; archived skills stay unrunnable; the
 * grantor-or-admin rule guards revocation.
 */

const owner: SessionUser = {
  id: "owner-uuid",
  email: "owner@example.com",
  displayName: "Owner",
  role: "user",
};

const recipient: SessionUser = {
  id: "recipient-uuid",
  email: "recipient@example.com",
  displayName: "Recipient",
  role: "user",
};

const admin: SessionUser = {
  id: "admin-uuid",
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin",
};

let selectRows: Array<Record<string, unknown>> = [];
let selectQueue: Array<Array<Record<string, unknown>>> = [];
let returningRows: Array<Record<string, unknown>> = [];
let insertValues: Array<Record<string, unknown>> = [];
let updateSets: Array<Record<string, unknown>> = [];

function installDbMock() {
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return undefined;
          if (prop === "set") {
            return (value: Record<string, unknown>) => {
              updateSets.push(value);
              return proxy;
            };
          }
          if (prop === "values") {
            return (value: Record<string, unknown>) => {
              insertValues.push(value);
              return proxy;
            };
          }
          if (prop === "returning") {
            return () => Promise.resolve(returningRows);
          }
          if (prop === "limit" || prop === "orderBy") {
            return () => Promise.resolve(selectQueue.shift() ?? selectRows);
          }
          return () => proxy;
        },
      },
    );
    return { ...actual, getDb: () => proxy as never };
  });
}

afterEach(() => {
  selectRows = [];
  selectQueue = [];
  returningRows = [];
  insertValues = [];
  updateSets = [];
  vi.resetModules();
});

const privateSkill = {
  id: "skill-1",
  ownerUserId: owner.id,
  isStarter: false,
  archivedAt: null as Date | null,
};

describe("canActorAccessSkill / canActorRunSkill", () => {
  it("grants access to a recipient with an active share", async () => {
    installDbMock();
    const { getDb } = await import("@ai-workspace/db");
    const { canActorAccessSkill, canActorRunSkill } = await import(
      "@/lib/shares"
    );

    selectRows = [{ id: "share-1" }]; // hasActiveShare finds a row
    expect(
      await canActorAccessSkill(getDb(), privateSkill, recipient),
    ).toBe(true);
    expect(await canActorRunSkill(getDb(), privateSkill, recipient)).toBe(true);
  });

  it("denies a stranger with no share", async () => {
    installDbMock();
    const { getDb } = await import("@ai-workspace/db");
    const { canActorAccessSkill } = await import("@/lib/shares");

    selectRows = []; // no active share
    expect(
      await canActorAccessSkill(getDb(), privateSkill, recipient),
    ).toBe(false);
  });

  it("never lets a share make an archived skill runnable", async () => {
    installDbMock();
    const { getDb } = await import("@ai-workspace/db");
    const { canActorRunSkill, canActorAccessSkill } = await import(
      "@/lib/shares"
    );

    selectRows = [{ id: "share-1" }];
    const archived = { ...privateSkill, archivedAt: new Date() };
    expect(await canActorRunSkill(getDb(), archived, recipient)).toBe(false);
    // and access checks short-circuit for archived non-owned skills
    expect(await canActorAccessSkill(getDb(), archived, recipient)).toBe(false);
  });

  it("owner access never consults shares", async () => {
    installDbMock();
    const { getDb } = await import("@ai-workspace/db");
    const { canActorAccessSkill } = await import("@/lib/shares");

    selectRows = []; // even with no shares, owner sees it
    expect(await canActorAccessSkill(getDb(), privateSkill, owner)).toBe(true);
  });
});

describe("parseAppShareRole", () => {
  it("defaults unknown roles to viewer", async () => {
    const { parseAppShareRole } = await import("@/lib/shares");

    expect(parseAppShareRole("editor")).toBe("editor");
    expect(parseAppShareRole("viewer")).toBe("viewer");
    expect(parseAppShareRole("admin")).toBe("viewer");
    expect(parseAppShareRole(undefined)).toBe("viewer");
  });
});

describe("createShare recipient lookup", () => {
  const request = {
    actor: owner,
    subjectType: "skill" as const,
    subjectId: "skill-1",
    subjectSlug: "my-skill",
    recipientEmail: "recipient@example.com",
  };

  it("shares with the one user who holds the address", async () => {
    installDbMock();
    selectQueue = [[{ id: recipient.id, email: recipient.email }]];
    returningRows = [{ id: "share-1", role: "viewer" }];
    const { createShare } = await import("@/lib/shares");
    const { getDb } = await import("@ai-workspace/db");

    const result = await createShare({ db: getDb(), ...request });

    expect(result.ok).toBe(true);
    expect(insertValues[0]).toMatchObject({ grantedToUserId: recipient.id });
  });

  it("refuses to guess when two users hold the same address", async () => {
    installDbMock();
    selectQueue = [
      [
        { id: recipient.id, email: recipient.email },
        { id: "other-uuid", email: recipient.email },
      ],
    ];
    const { createShare } = await import("@/lib/shares");
    const { getDb } = await import("@ai-workspace/db");

    const result = await createShare({ db: getDb(), ...request });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: "recipient_ambiguous",
    });
    expect(insertValues).toEqual([]);
  });
});

describe("app share management", () => {
  const adminCreatedAppShare = {
    id: "share-1",
    subjectType: "app",
    subjectId: "app-1",
    grantedToUserId: recipient.id,
    grantedByUserId: admin.id,
    role: "viewer",
    revokedAt: null,
    createdAt: new Date("2026-06-17T12:00:00.000Z"),
    updatedAt: new Date("2026-06-17T12:00:00.000Z"),
  };

  it("lets the app owner update an admin-created app share role", async () => {
    installDbMock();
    selectQueue = [
      [adminCreatedAppShare],
      [{ ownerUserId: owner.id }],
    ];
    returningRows = [{ ...adminCreatedAppShare, role: "editor" }];

    const { getDb } = await import("@ai-workspace/db");
    const { updateShareRole } = await import("@/lib/shares");
    const result = await updateShareRole({
      db: getDb(),
      actor: owner,
      shareId: adminCreatedAppShare.id,
      role: "editor",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.share.role).toBe("editor");
    expect(updateSets).toContainEqual(
      expect.objectContaining({ role: "editor" }),
    );
    expect(insertValues).toContainEqual(
      expect.objectContaining({
        actorUserId: owner.id,
        actionType: "app_share_role_update",
      }),
    );
  });

  it("lets the app owner revoke an admin-created app share", async () => {
    installDbMock();
    selectQueue = [
      [adminCreatedAppShare],
      [{ ownerUserId: owner.id }],
    ];

    const { getDb } = await import("@ai-workspace/db");
    const { revokeShare } = await import("@/lib/shares");
    const result = await revokeShare({
      db: getDb(),
      actor: owner,
      shareId: adminCreatedAppShare.id,
    });

    expect(result.ok).toBe(true);
    expect(updateSets).toContainEqual(
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
    expect(insertValues).toContainEqual(
      expect.objectContaining({
        actorUserId: owner.id,
        actionType: "app_share_revoke",
      }),
    );
  });
});
