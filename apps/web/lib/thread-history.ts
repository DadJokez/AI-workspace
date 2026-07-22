export interface ThreadHistoryItem {
  id: string;
  pinned: boolean;
  updatedAt: string;
}

/**
 * Personal chat history has one predictable order: pinned conversations first,
 * then every other conversation, newest first within each set. Preserve API
 * order for exact timestamp ties so optimistic updates do not make rows jump.
 */
export function sortThreadHistory<T extends ThreadHistoryItem>(
  threads: T[],
): T[] {
  return threads
    .map((thread, index) => ({ thread, index }))
    .sort((a, b) => {
      if (a.thread.pinned !== b.thread.pinned) {
        return a.thread.pinned ? -1 : 1;
      }
      const recency =
        Date.parse(b.thread.updatedAt) - Date.parse(a.thread.updatedAt);
      return recency || a.index - b.index;
    })
    .map(({ thread }) => thread);
}
