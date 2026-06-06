import { describe, expect, it } from "vitest";
import { buildWorkReceipts } from "@/lib/work-receipts";

describe("buildWorkReceipts", () => {
  it("aggregates workspace work into one compact receipt", () => {
    const receipts = buildWorkReceipts([
      {
        id: "evt_1",
        state: "succeeded",
        label: "Checked local notes",
        at: "2026-06-01T10:00:00.000Z",
      },
      {
        id: "evt_2",
        state: "succeeded",
        label: "Searched company AI references",
        at: "2026-06-01T10:00:01.000Z",
      },
      {
        id: "evt_3",
        state: "succeeded",
        label: "Ran production build",
        at: "2026-06-01T10:00:02.000Z",
      },
    ]);

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      kind: "workspace",
      state: "succeeded",
      summary: "Explored 1 file, 1 search, and ran 1 command",
    });
    expect(receipts[0]?.steps.map((step) => step.label)).toEqual([
      "Checked local notes",
      "Searched company AI references",
      "Ran production build",
    ]);
  });

  it("groups GitHub and browser work separately from lifecycle noise", () => {
    const receipts = buildWorkReceipts([
      {
        id: "evt_1",
        state: "succeeded",
        label: "Started local streaming chat run",
        at: "2026-06-01T10:00:00.000Z",
      },
      {
        id: "evt_2",
        state: "succeeded",
        label: "Checked GitHub pull requests",
        at: "2026-06-01T10:00:01.000Z",
      },
      {
        id: "evt_3",
        state: "succeeded",
        label: "Used the browser",
        at: "2026-06-01T10:00:02.000Z",
      },
      {
        id: "evt_4",
        state: "succeeded",
        label: "Stored assistant answer",
        at: "2026-06-01T10:00:03.000Z",
      },
    ]);

    expect(receipts.map((receipt) => receipt.summary)).toEqual([
      "Checked GitHub pull requests",
      "Used the browser",
    ]);
  });

  it("creates one live receipt while a run is pending", () => {
    const receipts = buildWorkReceipts(
      [
        {
          id: "evt_1",
          state: "succeeded",
          label: "Started local streaming chat run",
          at: "2026-06-01T10:00:00.000Z",
        },
        {
          id: "evt_2",
          state: "pending",
          label: "Checking GitHub details...",
          at: "2026-06-01T10:00:01.000Z",
        },
      ],
      { pending: true },
    );

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      id: "active-work",
      kind: "github",
      state: "pending",
      summary: "Working... checking GitHub details",
    });
    expect(receipts[0]?.steps).toHaveLength(2);
  });

  it("keeps raw error detail nested in failed steps", () => {
    const receipts = buildWorkReceipts([
      {
        id: "evt_1",
        state: "failed",
        label: "Could not search GitHub",
        detail: "{\"message\":\"token expired\",\"secret\":\"[redacted]\"}",
        at: "2026-06-01T10:00:00.000Z",
      },
    ]);

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      kind: "attention",
      state: "failed",
      summary: "1 step needs attention",
    });
    expect(receipts[0]?.summary).not.toContain("token expired");
    expect(receipts[0]?.steps[0]?.detail).toContain("token expired");
  });
});
