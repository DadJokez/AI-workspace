import { describe, expect, it } from "vitest";
import {
  isAllowedSandboxPort,
  parseStudioBrowserAction,
  parseStudioBrowserStartRequest,
  studioBrowserTargetKey,
} from "@/lib/studio-browser-contract";

const threadId = "00000000-0000-4000-8000-000000000701";
const messageId = "00000000-0000-4000-8000-000000000702";
const sandboxId = "00000000-0000-4000-8000-000000000703";

describe("Studio Browser contract", () => {
  it("parses exact evidence and sandbox targets", () => {
    expect(
      parseStudioBrowserStartRequest({
        threadId,
        target: { kind: "evidence", messageId, sourceNumber: 2 },
      }),
    ).toEqual({
      threadId,
      target: { kind: "evidence", messageId, sourceNumber: 2 },
    });
    expect(
      parseStudioBrowserStartRequest({
        threadId,
        target: { kind: "sandbox", sandboxId, port: 3000 },
      }).target,
    ).toEqual({ kind: "sandbox", sandboxId, port: 3000 });
  });

  it("rejects malformed identifiers, source numbers, ports, and actions", () => {
    expect(() =>
      parseStudioBrowserStartRequest({
        threadId: "thread",
        target: { kind: "evidence", messageId, sourceNumber: 1 },
      }),
    ).toThrow(/thread and supported Browser target/);
    expect(() =>
      parseStudioBrowserStartRequest({
        threadId,
        target: { kind: "evidence", messageId, sourceNumber: 0 },
      }),
    ).toThrow(/invalid or unsupported/);
    expect(isAllowedSandboxPort(80)).toBe(false);
    expect(isAllowedSandboxPort(3000)).toBe(true);
    expect(() => parseStudioBrowserAction({ action: "navigate" })).toThrow(
      /back, forward, or reload/,
    );
  });

  it("builds stable target keys without carrying display URLs", () => {
    expect(
      studioBrowserTargetKey({
        kind: "evidence",
        messageId,
        sourceNumber: 4,
      }),
    ).toBe(`evidence:${messageId}:4`);
    expect(
      studioBrowserTargetKey({ kind: "sandbox", sandboxId, port: 5173 }),
    ).toBe(`sandbox:${sandboxId}:5173`);
  });
});
