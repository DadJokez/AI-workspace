import { describe, expect, it } from "vitest";
import type { AgentActivityEvent } from "@/lib/activity-events";
import { groupActivityEvents, inferCategory } from "@/lib/activity-receipts";

/** #119 — aggregation helper for collapsible work receipts. */
describe("groupActivityEvents", () => {
  const ev = (
    overrides: Partial<AgentActivityEvent> & { id: string },
  ): AgentActivityEvent => ({
    state: "succeeded",
    label: "Checked GitHub details",
    ...overrides,
  });

  it("groups mixed events into category receipts with counts", () => {
    const receipts = groupActivityEvents([
      ev({ id: "1", category: "github", label: "Searched GitHub", at: "2026-06-12T10:00:00Z" }),
      ev({ id: "2", category: "github", label: "Checked GitHub details", at: "2026-06-12T10:00:01Z" }),
      ev({ id: "3", category: "workspace", label: "Checked local notes", at: "2026-06-12T10:00:02Z" }),
      ev({ id: "4", category: "progress", label: "Stored assistant answer", at: "2026-06-12T10:00:03Z" }),
    ]);

    expect(receipts.map((r) => r.category)).toEqual([
      "github",
      "workspace",
      "progress",
    ]);
    expect(receipts[0]).toMatchObject({
      label: "Checked GitHub · 2 steps",
      state: "succeeded",
    });
    // Single-event receipts keep their human label verbatim.
    expect(receipts[1]!.label).toBe("Checked local notes");
  });

  it("orders receipts by when their work actually started", () => {
    const receipts = groupActivityEvents([
      ev({ id: "1", category: "progress", label: "Queued retry", at: "2026-06-12T09:00:00Z" }),
      ev({ id: "2", category: "github", label: "Searched GitHub", at: "2026-06-12T09:00:05Z" }),
    ]);
    expect(receipts.map((r) => r.category)).toEqual(["progress", "github"]);
  });

  it("bubbles failures into state and label", () => {
    const receipts = groupActivityEvents([
      ev({ id: "1", category: "github", state: "failed", label: "Could not search GitHub" }),
      ev({ id: "2", category: "github", label: "Checked GitHub details" }),
    ]);
    expect(receipts[0]).toMatchObject({
      state: "failed",
      label: "Checked GitHub · 2 steps · 1 needs attention",
    });
  });

  it("marks receipts pending while any step is still running", () => {
    const receipts = groupActivityEvents([
      ev({ id: "1", category: "tools", state: "pending", label: "Checking sources..." }),
      ev({ id: "2", category: "tools", label: "Checked sources" }),
    ]);
    expect(receipts[0]!.state).toBe("pending");
  });

  it("infers categories for events persisted before categories existed", () => {
    expect(inferCategory("Searched GitHub")).toBe("github");
    expect(inferCategory("Checked Vault context")).toBe("context");
    expect(inferCategory("Background worker claimed the run")).toBe("progress");
    expect(inferCategory("checked local notes")).toBe("workspace");
    expect(inferCategory("Finished a step")).toBe("tools");

    const receipts = groupActivityEvents([
      ev({ id: "1", category: undefined, label: "Started AgentCore run" }),
      ev({ id: "2", category: undefined, label: "Searched GitHub" }),
    ]);
    expect(receipts.map((r) => r.category).sort()).toEqual([
      "github",
      "progress",
    ]);
  });
});
