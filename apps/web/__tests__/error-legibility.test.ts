// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncStatusNotice } from "@/components/AsyncStatusNotice";
import { Sidebar, type ThreadSummary } from "@/components/Sidebar";
import { IntegrationsSettings } from "@/components/ToolsPanel";
import { SkillActions } from "@/components/skills/SkillActions";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));
const fetchJson = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/client-api", () => ({ fetchJson }));

const thread: ThreadSummary = {
  id: "thread-1",
  title: "Quarterly plan",
  pinned: false,
  defaultModelId: "model-1",
  previewSummary: null,
  previewSummaryUpdatedAt: null,
  titleSource: "user",
  createdAt: "2026-08-12T12:00:00.000Z",
  updatedAt: "2026-08-12T12:00:00.000Z",
};

beforeEach(() => {
  router.push.mockReset();
  router.refresh.mockReset();
  fetchJson.mockReset();
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0),
  );
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("async failure legibility", () => {
  it("announces and dismisses a persistent async error", () => {
    const onDismiss = vi.fn();
    render(
      createElement(AsyncStatusNotice, {
        message: "Could not save the change.",
        onDismiss,
        floating: true,
      }),
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Could not save the change.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("surfaces a rejected Sidebar mutation instead of swallowing it", async () => {
    const onPinThread = vi
      .fn()
      .mockRejectedValue(new Error("Pinning is temporarily unavailable."));
    render(
      createElement(Sidebar, {
        open: true,
        onClose: vi.fn(),
        onNewChat: vi.fn(),
        onSearch: vi.fn(),
        threads: [thread],
        threadsLoading: false,
        onOpenThread: vi.fn(),
        onPinThread,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Pinning is temporarily unavailable.",
    );
    expect(onPinThread).toHaveBeenCalledWith("thread-1", true);
  });

  it("uses the shared destructive dialog before archiving a skill", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm");
    fetchJson.mockRejectedValue(new Error("Archive failed."));
    render(
      createElement(SkillActions, {
        skillId: "skill-1",
        isOwner: true,
        showArchive: true,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    let dialog = screen.getByRole("alertdialog", { name: "Archive skill?" });
    expect(dialog.textContent).toContain("run history will be kept");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    dialog = screen.getByRole("alertdialog", { name: "Archive skill?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(fetchJson).toHaveBeenCalledOnce());
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Archive failed.",
    );
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it("uses danger and warning states for integration failures", async () => {
    window.history.replaceState(
      {},
      "",
      "/?connected=google&error=access_denied",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          providerDetails: {
            github: {
              connected: true,
              toolAvailable: false,
              status: "reconnect_required",
            },
          },
        }),
      }),
    );

    render(createElement(IntegrationsSettings));

    expect((await screen.findByRole("alert")).className).toContain(
      "text-danger",
    );
    expect((await screen.findByText("Auth failed")).className).toContain(
      "text-danger",
    );
    expect(
      (await screen.findByText("Reconnect", { selector: "span" })).className,
    ).toContain("text-warning");
    expect(
      screen.getAllByRole("button", { name: "Learn more" }).length,
    ).toBeGreaterThan(0);
  });
});
