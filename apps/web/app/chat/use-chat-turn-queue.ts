"use client";

import {
  chatTurnQueueStorageKey,
  createQueuedChatTurn,
  editQueuedChatTurn,
  mergeQueuedChatTurns,
  moveQueuedChatTurn,
  moveQueuedChatTurnToFront,
  parseQueuedChatTurns,
  type QueuedChatTurn,
  type QueuedChatTurnDraft,
} from "@/lib/chat-turn-queue";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export function useChatTurnQueue({
  userId,
  tabId,
  threadId,
}: {
  userId?: string;
  tabId?: string;
  threadId?: string;
}) {
  const storageKey = useMemo(
    () => chatTurnQueueStorageKey({ userId, tabId, threadId }),
    [tabId, threadId, userId],
  );
  const transientStorageKey = useMemo(
    () => chatTurnQueueStorageKey({ userId, tabId }),
    [tabId, userId],
  );
  const [turns, setTurns] = useState<QueuedChatTurn[]>([]);
  const [loadedStorageKey, setLoadedStorageKey] = useState<string | null>(null);
  const turnsRef = useRef(turns);
  const loadedStorageKeyRef = useRef(loadedStorageKey);
  const requestedStorageKeyRef = useRef(storageKey);
  turnsRef.current = turns;
  loadedStorageKeyRef.current = loadedStorageKey;
  requestedStorageKeyRef.current = storageKey;

  useEffect(() => {
    if (!storageKey) {
      setTurns([]);
      setLoadedStorageKey(null);
      return;
    }
    let restored: QueuedChatTurn[] = [];
    try {
      restored = parseQueuedChatTurns(window.localStorage.getItem(storageKey));
      if (
        threadId &&
        transientStorageKey &&
        transientStorageKey !== storageKey
      ) {
        const transient = parseQueuedChatTurns(
          window.localStorage.getItem(transientStorageKey),
        );
        const inMemoryTransient =
          loadedStorageKeyRef.current === transientStorageKey
            ? turnsRef.current
            : [];
        restored = mergeQueuedChatTurns(
          mergeQueuedChatTurns(inMemoryTransient, transient),
          restored,
        );
        if (restored.length > 0) {
          window.localStorage.setItem(storageKey, JSON.stringify(restored));
        }
        window.localStorage.removeItem(transientStorageKey);
      }
    } catch {
      // Queue persistence is best-effort; the in-memory queue still works.
    }
    setTurns(restored);
    setLoadedStorageKey(storageKey);
  }, [storageKey, threadId, transientStorageKey]);

  useEffect(() => {
    if (!storageKey || loadedStorageKey !== storageKey) return;
    try {
      if (turns.length === 0) {
        window.localStorage.removeItem(storageKey);
      } else {
        window.localStorage.setItem(storageKey, JSON.stringify(turns));
      }
    } catch {
      // A locked-down browser should not disable queueing for the active page.
    }
  }, [loadedStorageKey, storageKey, turns]);

  const mutateScope = useCallback(
    (
      scopeKey: string | null | undefined,
      update: (current: QueuedChatTurn[]) => QueuedChatTurn[],
    ) => {
      const targetKey = scopeKey ?? loadedStorageKeyRef.current;
      if (!targetKey) return;
      if (
        loadedStorageKeyRef.current === targetKey &&
        requestedStorageKeyRef.current === targetKey
      ) {
        setTurns(update);
        return;
      }
      updatePersistedQueue(targetKey, update);
    },
    [],
  );

  const enqueue = useCallback((draft: QueuedChatTurnDraft) => {
    const turn = createQueuedChatTurn(draft);
    const targetKey = requestedStorageKeyRef.current;
    if (
      targetKey &&
      loadedStorageKeyRef.current !== targetKey
    ) {
      updatePersistedQueue(targetKey, (current) => [...current, turn]);
    } else {
      setTurns((current) => [...current, turn]);
    }
    return turn;
  }, []);

  const update = useCallback((id: string, text: string, scopeKey?: string) => {
    mutateScope(scopeKey, (current) =>
      current.map((turn) =>
        turn.id === id ? editQueuedChatTurn(turn, text) : turn,
      ),
    );
  }, [mutateScope]);

  const remove = useCallback((id: string, scopeKey?: string) => {
    mutateScope(scopeKey, (current) =>
      current.filter((turn) => turn.id !== id),
    );
  }, [mutateScope]);

  const move = useCallback((id: string, offset: -1 | 1, scopeKey?: string) => {
    mutateScope(scopeKey, (current) =>
      moveQueuedChatTurn(current, id, offset),
    );
  }, [mutateScope]);

  const applyNext = useCallback((id: string, scopeKey?: string) => {
    mutateScope(scopeKey, (current) =>
      moveQueuedChatTurnToFront(current, id),
    );
  }, [mutateScope]);

  const markSending = useCallback((id: string, scopeKey?: string) => {
    mutateScope(scopeKey, (current) =>
      current.map((turn) =>
        turn.id === id
          ? { ...turn, status: "sending" as const, error: undefined }
          : turn,
      ),
    );
  }, [mutateScope]);

  const markFailed = useCallback((id: string, error: string, scopeKey?: string) => {
    mutateScope(scopeKey, (current) =>
      current.map((turn) =>
        turn.id === id
          ? { ...turn, status: "failed" as const, error }
          : turn,
      ),
    );
  }, [mutateScope]);

  const retry = useCallback((id: string, scopeKey?: string) => {
    mutateScope(scopeKey, (current) =>
      current.map((turn) =>
        turn.id === id
          ? { ...turn, status: "queued" as const, error: undefined }
          : turn,
      ),
    );
  }, [mutateScope]);

  const loaded = storageKey !== null && loadedStorageKey === storageKey;

  return {
    turns: loaded ? turns : [],
    loaded,
    scopeKey: loaded ? storageKey : null,
    enqueue,
    update,
    remove,
    move,
    applyNext,
    markSending,
    markFailed,
    retry,
  };
}

function updatePersistedQueue(
  storageKey: string,
  update: (current: QueuedChatTurn[]) => QueuedChatTurn[],
) {
  try {
    const current = parseQueuedChatTurns(window.localStorage.getItem(storageKey));
    const next = update(current);
    if (next.length === 0) {
      window.localStorage.removeItem(storageKey);
    } else {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    }
  } catch {
    // Cross-thread settlement is best-effort when storage is unavailable.
  }
}
