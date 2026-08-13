// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillForm } from "@/components/skills/SkillForm";
import { modelDisplayName } from "@/lib/model-display";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));

beforeEach(() => {
  router.push.mockReset();
  router.refresh.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("skill surface polish", () => {
  it("uses human model names without exposing unknown internal IDs", () => {
    expect(modelDisplayName("sonnet-4-5")).toBe("Sonnet 4.5");
    expect(modelDisplayName("provider.internal-model-v1")).toBe(
      "Comparative model",
    );
  });

  it("hides a pinned model and shows honest tool connection states", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          providerDetails: {
            github: {
              connected: true,
              toolAvailable: true,
              status: "ready",
            },
            notion: {
              connected: false,
              toolAvailable: false,
              status: "not_connected",
            },
          },
        }),
      }),
    );

    render(
      createElement(SkillForm, {
        mode: "create",
        modelOptions: ["sonnet-4-5"],
        providerOptions: ["github", "notion", "web"],
      }),
    );

    expect(screen.queryByLabelText("Model")).toBeNull();
    expect(screen.getByLabelText("GitHub")).toBeTruthy();
    expect(screen.getByLabelText("Notion")).toBeTruthy();
    expect(screen.getByLabelText("Web access")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByText("Not connected")).toBeTruthy();
    });
    expect(screen.getByText("Built in")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Connect in Settings" }).getAttribute(
        "href",
      ),
    ).toBe("/chat?open=settings&section=integrations");
  });

  it("uses human labels when users can choose between models", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );

    render(
      createElement(SkillForm, {
        mode: "create",
        modelOptions: ["haiku-4-5", "sonnet-4-5"],
        providerOptions: [],
      }),
    );

    const select = screen.getByLabelText("Model");
    expect(
      within(select).getByRole("option", { name: "Haiku 4.5" }),
    ).toBeTruthy();
    expect(
      within(select).getByRole("option", { name: "Sonnet 4.5" }),
    ).toBeTruthy();
    expect(screen.queryByText("sonnet-4-5")).toBeNull();
  });
});
