import { describe, expect, it } from "vitest";
import { parseRunInspectorTrace } from "@/lib/run-inspector";

describe("parseRunInspectorTrace", () => {
  it("parses a valid trace and drops malformed event rows", () => {
    const trace = parseRunInspectorTrace({
      schema: "run-inspector.v1",
      generatedAt: "2026-07-15T01:00:03.000Z",
      run: {
        id: "11111111-1111-4111-8111-111111111361",
        status: "succeeded",
        inputs: { prompt: "Inspect this run" },
        outputs: { assistantText: "Done." },
      },
      events: [
        {
          id: "event-1",
          sequence: 1,
          eventType: "provider_reasoning",
          status: "succeeded",
          label: "Captured provider reasoning",
          output: { state: "available" },
          occurredAt: "2026-07-15T01:00:01.000Z",
        },
        { id: "invalid-event" },
      ],
      auditEvents: [],
    });

    expect(trace).not.toBeNull();
    expect(trace?.run.outputs).toEqual({ assistantText: "Done." });
    expect(trace?.events).toHaveLength(1);
    expect(trace?.events[0]?.eventType).toBe("provider_reasoning");
  });

  it("rejects an unknown trace schema", () => {
    expect(
      parseRunInspectorTrace({
        schema: "run-inspector.v2",
        generatedAt: "2026-07-15T01:00:03.000Z",
        run: { id: "run-1", status: "succeeded" },
      }),
    ).toBeNull();
  });
});
