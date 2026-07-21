import { describe, expect, it } from "vitest";
import { reconcilePendingRunMessages } from "@/app/chat/use-run-polling";
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
