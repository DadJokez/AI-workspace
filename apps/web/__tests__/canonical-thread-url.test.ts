import { describe, expect, it } from "vitest";
import { canonicalThreadUrl } from "@/app/chat/chat-client-state";

const base = "https://app.example.com/chat";

describe("canonicalThreadUrl", () => {
  it("adds threadId when the active tab has a thread", () => {
    expect(canonicalThreadUrl(base, "thread-a")).toBe(
      `${base}?threadId=thread-a`,
    );
  });

  it("replaces a stale threadId with the active one", () => {
    expect(canonicalThreadUrl(`${base}?threadId=thread-a`, "thread-b")).toBe(
      `${base}?threadId=thread-b`,
    );
  });

  it("returns null when the URL is already canonical", () => {
    expect(canonicalThreadUrl(`${base}?threadId=thread-a`, "thread-a")).toBe(
      null,
    );
    expect(canonicalThreadUrl(base, undefined)).toBe(null);
  });

  it("removes threadId and inspectRun for a draft tab", () => {
    expect(
      canonicalThreadUrl(
        `${base}?threadId=thread-a&inspectRun=run-1`,
        undefined,
      ),
    ).toBe(base);
  });

  it("keeps inspectRun deep links that never had a threadId", () => {
    expect(canonicalThreadUrl(`${base}?inspectRun=run-1`, undefined)).toBe(
      null,
    );
  });

  it("preserves unrelated query params", () => {
    expect(
      canonicalThreadUrl(`${base}?open=settings&threadId=thread-a`, undefined),
    ).toBe(`${base}?open=settings`);
    expect(canonicalThreadUrl(`${base}?open=artifacts`, "thread-a")).toBe(
      `${base}?open=artifacts&threadId=thread-a`,
    );
  });

  it("keeps inspectRun alongside the thread it belongs to", () => {
    expect(
      canonicalThreadUrl(
        `${base}?threadId=thread-a&inspectRun=run-1`,
        "thread-a",
      ),
    ).toBe(null);
  });
});
