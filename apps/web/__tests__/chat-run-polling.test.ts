import { describe, expect, it } from "vitest";
import {
  applyPendingRunTelemetry,
  reconcilePendingRunMessages,
} from "@/app/chat/use-run-polling";
import type { UiMessage } from "@/app/chat/chat-client-state";

const message = (
  id: string,
  role: UiMessage["role"],
  content: string,
  pending = false,
): UiMessage => ({ id, role, content, pending });

describe("reconcilePendingRunMessages", () => {
  it("keeps the run placeholder while the loaded run is still pending", () => {
    const loaded = [message("run:123", "assistant", "", true)];
    const current = [
      message("user-1", "user", "Build the report"),
      message("run:123", "assistant", "", true),
    ];

    expect(reconcilePendingRunMessages(loaded, current)).toEqual([
      loaded[0],
      current[0],
    ]);
  });

  it("replaces the stale run placeholder with the terminal assistant result", () => {
    const loaded = [message("assistant-1", "assistant", "Report complete")];
    const current = [
      message("user-1", "user", "Build the report"),
      message("run:123", "assistant", "", true),
    ];

    expect(reconcilePendingRunMessages(loaded, current)).toEqual([
      loaded[0],
      current[0],
    ]);
  });
});

describe("applyPendingRunTelemetry", () => {
  it("updates only the matching pending worker placeholder", () => {
    const messages = [
      message("run:123", "assistant", "", true),
      message("run:other", "assistant", "", true),
    ];

    expect(applyPendingRunTelemetry(messages, "123", 8_400)).toEqual([
      { ...messages[0], liveTokens: 8_400 },
      messages[1],
    ]);
  });

  it("never regresses a newer client total or mutates terminal messages", () => {
    const pending = {
      ...message("run:123", "assistant", "", true),
      liveTokens: 9_100,
    };
    expect(applyPendingRunTelemetry([pending], "123", 8_400)[0]).toBe(
      pending,
    );
    const terminal = message("run:123", "assistant", "Done", false);
    expect(applyPendingRunTelemetry([terminal], "123", 10_000)[0]).toBe(
      terminal,
    );
    expect(applyPendingRunTelemetry([pending], "123", undefined)[0]).toBe(
      pending,
    );
    expect(applyPendingRunTelemetry([pending], "123", Number.NaN)[0]).toBe(
      pending,
    );
  });
});
