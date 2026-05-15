import { describe, expect, it } from "vitest";
import {
  buildToolActivityEvents,
  summarizeActivity,
} from "@/lib/activity-events";

describe("buildToolActivityEvents", () => {
  it("turns persisted tool calls and results into ordered activity rows", () => {
    const events = buildToolActivityEvents(
      [
        {
          id: "call_1",
          name: "github_list_issues",
          provider: "github",
          toolName: "list_issues",
          input: { state: "open" },
          startedAt: "2026-05-15T10:00:00.000Z",
        },
        {
          id: "call_2",
          name: "github_get_issue",
          provider: "github",
          toolName: "get_issue",
          input: { number: 49 },
          startedAt: "2026-05-15T10:00:02.000Z",
        },
      ],
      [
        {
          toolCallId: "call_1",
          name: "github_list_issues",
          provider: "github",
          toolName: "list_issues",
          output: [{ number: 49 }],
          isError: false,
          completedAt: "2026-05-15T10:00:01.000Z",
        },
      ],
    );

    expect(events.map((event) => [event.state, event.label])).toEqual([
      ["succeeded", "Ran GitHub · list issues"],
      ["pending", "Calling GitHub · get issue"],
    ]);
  });
});

describe("summarizeActivity", () => {
  it("prefers live status while a turn is pending", () => {
    expect(summarizeActivity([], true, "Calling GitHub...")).toBe(
      "Calling GitHub...",
    );
  });

  it("summarizes completed and failed tool activity", () => {
    expect(
      summarizeActivity(
        [
          {
            id: "call_1",
            state: "succeeded",
            label: "Ran GitHub · list issues",
          },
          {
            id: "call_2",
            state: "succeeded",
            label: "Ran GitHub · get issue",
          },
        ],
        false,
        undefined,
      ),
    ).toBe("Ran 2 tools");

    expect(
      summarizeActivity(
        [
          {
            id: "call_1",
            state: "failed",
            label: "Failed GitHub · list issues",
          },
        ],
        false,
        undefined,
      ),
    ).toBe("1 tool failed");
  });
});
