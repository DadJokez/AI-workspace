export const WIZARD_STEP_STORAGE_KEY = "comparative.wizard.step";
export const WIZARD_NAME_STORAGE_KEY = "comparative.wizard.name";

const LEGACY_SKIN_STORAGE_KEY = "ui-skin";
const LEGACY_KEY_MAPPINGS = [
  ["aihub.wizard.step", WIZARD_STEP_STORAGE_KEY],
  ["aihub.wizard.name", WIZARD_NAME_STORAGE_KEY],
] as const;

type StorageAdapter = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export function migrateLegacyLocalStorage(storage: StorageAdapter): void {
  try {
    storage.removeItem(LEGACY_SKIN_STORAGE_KEY);

    for (const [legacyKey, currentKey] of LEGACY_KEY_MAPPINGS) {
      const legacyValue = storage.getItem(legacyKey);
      if (storage.getItem(currentKey) === null && legacyValue !== null) {
        storage.setItem(currentKey, legacyValue);
      }
      storage.removeItem(legacyKey);
    }
  } catch {
    // Storage can be disabled or unavailable in hardened browser contexts.
  }
}
