import { describe, expect, it, vi } from "vitest";
import {
  loadAppVersionDataBindings,
  pinAppVersionDataBindings,
} from "@/lib/app-version-bindings";

const binding = {
  id: "issues",
  provider: "github",
  toolName: "list_issues",
  pinnedArgs: { owner: "o", repo: "r" },
  label: "Issues",
};

describe("pinAppVersionDataBindings", () => {
  it("inserts one row per binding, insert-only (existing declarations win)", async () => {
    const onConflictDoNothing = vi.fn(async () => undefined);
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const tx = { insert: vi.fn(() => ({ values })) } as never;

    await pinAppVersionDataBindings(tx, {
      appVersionId: "version-1",
      bindings: [binding, { ...binding, id: "b2", label: undefined }],
    });

    expect(values).toHaveBeenCalledWith([
      {
        appVersionId: "version-1",
        bindingId: "issues",
        provider: "github",
        toolName: "list_issues",
        pinnedArgs: { owner: "o", repo: "r" },
        label: "Issues",
      },
      expect.objectContaining({ bindingId: "b2", label: null }),
    ]);
    expect(onConflictDoNothing).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.any(Array) }),
    );
  });

  it("writes nothing for a version without bindings", async () => {
    const tx = { insert: vi.fn() } as never;
    await pinAppVersionDataBindings(tx, { appVersionId: "v", bindings: [] });
    expect((tx as { insert: ReturnType<typeof vi.fn> }).insert).not.toHaveBeenCalled();
  });
});

describe("loadAppVersionDataBindings", () => {
  function dbWithRows(rows: unknown[]) {
    return {
      select: () => ({ from: () => ({ where: async () => rows }) }),
    } as never;
  }

  it("prefers the version's pinned rows and applies the same shape validation", async () => {
    const db = dbWithRows([
      {
        id: "issues",
        provider: "github",
        toolName: "list_issues",
        pinnedArgs: { owner: "o", repo: "r" },
        label: "Issues",
      },
      { id: "broken", provider: "github", toolName: "x", pinnedArgs: "nope", label: null },
    ]);
    const bindings = await loadAppVersionDataBindings(db, {
      appVersionId: "version-1",
      artifactMetadata: { dataBindings: [{ ...binding, id: "from-metadata" }] },
    });
    expect(bindings).toEqual([binding]);
  });

  it("falls back to artifact metadata for versions pinned before migration 0049", async () => {
    const bindings = await loadAppVersionDataBindings(dbWithRows([]), {
      appVersionId: "version-legacy",
      artifactMetadata: {
        dataBindings: [
          { id: "soql-1", provider: "salesforce", kind: "soql", query: "SELECT Id FROM Account" },
        ],
      },
    });
    expect(bindings).toEqual([
      {
        id: "soql-1",
        provider: "salesforce",
        toolName: "run_soql",
        pinnedArgs: { soql: "SELECT Id FROM Account" },
      },
    ]);
  });

  it("does not query when there is no version id", async () => {
    const select = vi.fn();
    const bindings = await loadAppVersionDataBindings({ select } as never, {
      appVersionId: null,
      artifactMetadata: { dataBindings: [binding] },
    });
    expect(select).not.toHaveBeenCalled();
    expect(bindings).toEqual([binding]);
  });
});
