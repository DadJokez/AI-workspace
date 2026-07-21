import { describe, expect, it } from "vitest";
import {
  migrateLegacyLocalStorage,
  WIZARD_NAME_STORAGE_KEY,
  WIZARD_STEP_STORAGE_KEY,
} from "@/lib/local-storage-migrations";

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("migrateLegacyLocalStorage", () => {
  it("removes the retired skin preference and migrates wizard progress", () => {
    const storage = createStorage({
      "ui-skin": "classic",
      "aihub.wizard.step": "tools",
      "aihub.wizard.name": "Atlas",
    });

    migrateLegacyLocalStorage(storage);

    expect(Object.fromEntries(storage.values)).toEqual({
      [WIZARD_STEP_STORAGE_KEY]: "tools",
      [WIZARD_NAME_STORAGE_KEY]: "Atlas",
    });
  });

  it("keeps current values when legacy and current keys both exist", () => {
    const storage = createStorage({
      "aihub.wizard.step": "tools",
      "aihub.wizard.name": "Atlas",
      [WIZARD_STEP_STORAGE_KEY]: "about",
      [WIZARD_NAME_STORAGE_KEY]: "Sage",
    });

    migrateLegacyLocalStorage(storage);
    migrateLegacyLocalStorage(storage);

    expect(Object.fromEntries(storage.values)).toEqual({
      [WIZARD_STEP_STORAGE_KEY]: "about",
      [WIZARD_NAME_STORAGE_KEY]: "Sage",
    });
  });

  it("does not fail when browser storage is unavailable", () => {
    const unavailableStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    };

    expect(() => migrateLegacyLocalStorage(unavailableStorage)).not.toThrow();
  });
});
