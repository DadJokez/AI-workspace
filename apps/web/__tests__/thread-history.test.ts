import { describe, expect, it } from "vitest";
import { sortThreadHistory } from "@/lib/thread-history";

function thread(
  id: string,
  updatedAt: string,
  pinned = false,
) {
  return { id, updatedAt, pinned };
}

describe("thread history ordering", () => {
  it("puts pinned threads first and keeps both sets newest first", () => {
    const result = sortThreadHistory([
      thread("old-unpinned", "2026-07-18T10:00:00.000Z"),
      thread("old-pinned", "2026-07-19T10:00:00.000Z", true),
      thread("new-unpinned", "2026-07-21T10:00:00.000Z"),
      thread("new-pinned", "2026-07-20T10:00:00.000Z", true),
    ]);

    expect(result.map(({ id }) => id)).toEqual([
      "new-pinned",
      "old-pinned",
      "new-unpinned",
      "old-unpinned",
    ]);
  });

  it("preserves API order for equal timestamps without mutating the input", () => {
    const input = [
      thread("first", "2026-07-21T10:00:00.000Z"),
      thread("second", "2026-07-21T10:00:00.000Z"),
    ];

    const result = sortThreadHistory(input);

    expect(result.map(({ id }) => id)).toEqual(["first", "second"]);
    expect(result).not.toBe(input);
    expect(input.map(({ id }) => id)).toEqual(["first", "second"]);
  });
});
