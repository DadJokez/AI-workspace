import { describe, expect, it } from "vitest";
import {
  adoptInitialThreadTab,
  makeFreshTab,
  type UiMessage,
} from "@/app/chat/chat-client-state";

const target = {
  threadId: "thread-1",
  title: "Quarterly CSV",
  modelId: "sonnet-4-6",
};

describe("adoptInitialThreadTab", () => {
  it("reuses the pristine boot tab's id so the composer keyed on it never remounts (#650)", () => {
    const boot = makeFreshTab("sonnet-4-5");
    const tab = adoptInitialThreadTab([boot], target);
    expect(tab.id).toBe(boot.id);
    expect(tab).toMatchObject({
      threadId: "thread-1",
      title: "Quarterly CSV",
      modelId: "sonnet-4-6",
      messages: [],
      busy: false,
      loaded: false,
    });
  });

  it("mints a new id once the boot tab already carries a conversation", () => {
    const message: UiMessage = { id: "m1", role: "user", content: "hi" };
    const boot = { ...makeFreshTab(), messages: [message] };
    const tab = adoptInitialThreadTab([boot], target);
    expect(tab.id).not.toBe(boot.id);
    expect(tab.threadId).toBe("thread-1");
  });

  it("mints a new id when the active tab is already bound to a thread", () => {
    const bound = { ...makeFreshTab(), threadId: "other-thread" };
    const tab = adoptInitialThreadTab([bound], target);
    expect(tab.id).not.toBe(bound.id);
    expect(tab.threadId).toBe("thread-1");
  });

  it("mints a new id when more than one tab exists", () => {
    const first = makeFreshTab();
    const second = makeFreshTab();
    const tab = adoptInitialThreadTab([first, second], target);
    expect(tab.id).not.toBe(first.id);
    expect(tab.id).not.toBe(second.id);
  });
});
