import { afterEach, describe, expect, it, vi } from "vitest";
import { readStoredSkin } from "@/lib/ui-skin";

describe("readStoredSkin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to Umber when browser storage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);

    expect(readStoredSkin()).toBe("umber");
  });

  it("preserves an explicit Classic preference", () => {
    vi.stubGlobal("localStorage", { getItem: () => "classic" });

    expect(readStoredSkin()).toBe("classic");
  });

  it.each([null, "umber", "unexpected"])(
    "defaults stored value %s to Umber",
    (stored) => {
      vi.stubGlobal("localStorage", { getItem: () => stored });

      expect(readStoredSkin()).toBe("umber");
    },
  );

  it("defaults to Umber when reading storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
    });

    expect(readStoredSkin()).toBe("umber");
  });
});
