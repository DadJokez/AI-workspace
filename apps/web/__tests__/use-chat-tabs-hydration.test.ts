// @vitest-environment jsdom
//
// Regression coverage for #711 (root cause of #709): the thread-hydration
// effect in use-chat-tabs.ts listed `defaultModelId` in its dependency array.
// When the server default (from /api/models) differs from the hardcoded
// client fallback constant, that dependency change cancelled the in-flight
// messages fetch, the immediate re-run bailed on the loadingThreadsRef guard,
// and the tab never left "Loading conversation".
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@/components/ModelSelector";
import { useChatTabs } from "@/app/chat/use-chat-tabs";
import type { ThreadMessagesResponse } from "@/app/chat/chat-client-state";

const SERVER_DEFAULT_MODEL_ID = "sonnet-4-6";
const CLIENT_FALLBACK_MODEL_ID = "sonnet-4-5";

const MODELS: ModelOption[] = [
  {
    id: SERVER_DEFAULT_MODEL_ID,
    displayName: "Claude Sonnet 4.6",
    blurb: "test model",
    costPer1MInput: 3,
    costPer1MOutput: 15,
  },
];

const THREAD_ID = "11111111-2222-4333-8444-555555555555";

function messagesBody(): ThreadMessagesResponse {
  return {
    messages: [
      {
        id: "message-1",
        role: "user",
        content: "hello from a persisted turn",
        modelId: SERVER_DEFAULT_MODEL_ID,
        runtime: "bedrock",
        toolCalls: null,
        toolResults: null,
        createdAt: "2026-07-26T00:00:00.000Z",
      },
    ],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Fetch stub whose response timing the test controls. */
function deferredFetch() {
  let resolve!: (response: Response) => void;
  const response = new Promise<Response>((r) => {
    resolve = r;
  });
  const fetchMock = vi.fn(() => response);
  return { fetchMock, resolve };
}

function hookProps(defaultModelId: string) {
  return {
    initialThreadId: THREAD_ID,
    userId: "user-1",
    models: MODELS,
    defaultModelId,
    threads: [],
    setThreads: vi.fn(),
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useChatTabs reload hydration under model drift (#711)", () => {
  it("completes hydration when the server default model changes while the messages fetch is in flight", async () => {
    const { fetchMock, resolve } = deferredFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      (props) => useChatTabs(props),
      { initialProps: hookProps(CLIENT_FALLBACK_MODEL_ID) },
    );

    // Boot state: the deep-linked thread was adopted and hydration started.
    expect(result.current.activeTab?.threadId).toBe(THREAD_ID);
    expect(result.current.activeTab?.loaded).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/threads/${THREAD_ID}/messages`,
      undefined,
    );

    // /api/models resolves with a default that drifted from the client
    // constant — this is the exact step that used to cancel hydration.
    rerender(hookProps(SERVER_DEFAULT_MODEL_ID));

    resolve(jsonResponse(200, messagesBody()));

    await waitFor(() => {
      expect(result.current.activeTab?.loaded).toBe(true);
    });
    expect(result.current.activeTab?.messages).toHaveLength(1);
    expect(result.current.activeTab?.messages[0]?.content).toBe(
      "hello from a persisted turn",
    );
    expect(result.current.activeTab?.error).toBeUndefined();
    // The original fetch was allowed to finish; no cancel-and-refetch churn.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the latest server default when the thread 404s during drift", async () => {
    const { fetchMock, resolve } = deferredFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      (props) => useChatTabs(props),
      { initialProps: hookProps(CLIENT_FALLBACK_MODEL_ID) },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender(hookProps(SERVER_DEFAULT_MODEL_ID));

    resolve(jsonResponse(404, { error: "thread_not_found" }));

    await waitFor(() => {
      expect(result.current.activeTab?.threadId).toBeUndefined();
    });
    // The fresh tab must carry the live server default, not the stale
    // client constant captured when the fetch started.
    expect(result.current.activeTab?.modelId).toBe(SERVER_DEFAULT_MODEL_ID);
    expect(result.current.activeTab?.loaded).toBe(true);
  });
});
