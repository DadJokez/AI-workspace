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

let selectRows: Array<Record<string, unknown>> = [];

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
          if (prop === "limit" || prop === "orderBy") {
            return () => Promise.resolve(selectRows);
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
