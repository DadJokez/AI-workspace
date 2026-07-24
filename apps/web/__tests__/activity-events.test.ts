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
      ["succeeded", "Searched GitHub"],
      ["pending", "Checking GitHub details..."],
    ]);
  });

  it("turns shell-like work into friendly research steps", () => {
    const events = buildToolActivityEvents(
      [
        {
          id: "call_1",
          name: "shell",
          provider: null,
          toolName: "shell",
          input: { cmd: "rg \"Georgia-Pacific AI\" docs" },
          startedAt: "2026-05-15T10:00:00.000Z",
        },
        {
          id: "call_2",
          name: "shell",
          provider: null,
          toolName: "shell",
          input: { cmd: "jq '.facts[]' notes.json" },
          startedAt: "2026-05-15T10:00:01.000Z",
        },
      ],
      [
        {
          toolCallId: "call_1",
          output: { stdout: "..." },
          isError: false,
          completedAt: "2026-05-15T10:00:02.000Z",
        },
        {
          toolCallId: "call_2",
          output: { stdout: "..." },
          isError: false,
          completedAt: "2026-05-15T10:00:03.000Z",
        },
      ],
    );

    expect(events.map((event) => event.label)).toEqual([
      "Searched company AI references",
      "Extracted supporting facts",
    ]);
    expect(events.map((event) => event.detail)).toEqual([undefined, undefined]);
  });

  it("uses an infinitive verb for failed web fetch activity", () => {
    const events = buildToolActivityEvents(
      [
        {
          id: "call_1",
          name: "web__fetch_url",
          provider: "web",
          toolName: "fetch_url",
          input: { url: "https://example.com/" },
          startedAt: "2026-05-15T10:00:00.000Z",
        },
      ],
      [
        {
          toolCallId: "call_1",
          output: "content-type is not readable text or HTML",
          isError: true,
          completedAt: "2026-05-15T10:00:01.000Z",
        },
      ],
    );

    expect(events[0]).toMatchObject({
      state: "failed",
      label: "Could not check Web details",
    });
  });

  it("shows fetched hosts in the completed work receipt", () => {
    const events = buildToolActivityEvents(
      [
        {
          id: "call_web",
          name: "web__fetch_url",
          provider: "web",
          toolName: "fetch_url",
          input: { url: "https://one.example/" },
          startedAt: "2026-05-15T10:00:00.000Z",
        },
      ],
      [
        {
          toolCallId: "call_web",
          output: { fetchedHosts: ["one.example", "two.example"] },
          isError: false,
          completedAt: "2026-05-15T10:00:01.000Z",
        },
      ],
    );

    expect(events[0]?.label).toBe(
      "Checked Web details · one.example, two.example",
    );
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
          { id: "call_1", state: "succeeded", label: "Searched GitHub" },
          { id: "call_2", state: "succeeded", label: "Checked GitHub details" },
        ],
        false,
        undefined,
      ),
    ).toBe("Finished research");

    expect(
      summarizeActivity(
        [
          {
            id: "call_1",
            state: "failed",
            label: "Could not search GitHub",
          },
        ],
        false,
        undefined,
      ),
    ).toBe("Finished with 1 failed step");
  });

  it("does not count historical lifecycle events as still running", () => {
    expect(
      summarizeActivity(
        [
          {
            id: "evt_1",
            state: "succeeded",
            label: "Queued background chat run",
          },
          {
            id: "evt_2",
            state: "succeeded",
            label: "Background worker claimed the run",
          },
          {
            id: "evt_3",
            state: "succeeded",
            label: "Stored assistant answer",
          },
        ],
        false,
        undefined,
      ),
    ).toBe("Finished response");
  });
});
