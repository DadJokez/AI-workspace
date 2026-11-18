// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationsSettings } from "@/components/ToolsPanel";
import {
  PUBLIC_RUNTIME_CONFIG_ELEMENT_ID,
  serializePublicRuntimeConfig,
} from "@/lib/public-runtime-config";

vi.mock("@/lib/client-api", () => ({ fetchJson: vi.fn() }));

function writeRuntimeConfig(connectors: string[] | null) {
  document.getElementById(PUBLIC_RUNTIME_CONFIG_ELEMENT_ID)?.remove();
  if (!connectors) return;
  const element = document.createElement("script");
  element.id = PUBLIC_RUNTIME_CONFIG_ELEMENT_ID;
  element.type = "application/json";
  element.textContent = serializePublicRuntimeConfig({
    analytics: null,
    connectors,
  });
  document.head.appendChild(element);
}

function stubStatus(providers: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...Object.fromEntries(providers.map((provider) => [provider, false])),
        providerDetails: Object.fromEntries(
          providers.map((provider) => [
            provider,
            { connected: false, toolAvailable: false, status: "not_connected" },
          ]),
        ),
      }),
    }),
  );
}

afterEach(() => {
  cleanup();
  writeRuntimeConfig(null);
  vi.unstubAllGlobals();
});

describe("integrations settings follow the deployment's connectors", () => {
  it("shows no card for a connector the deployment has turned off", async () => {
    writeRuntimeConfig(["github", "salesforce"]);
    stubStatus(["github", "salesforce"]);

    render(createElement(IntegrationsSettings));

    expect(await screen.findByTestId("tool-card-github")).toBeTruthy();
    expect(screen.getByTestId("tool-card-salesforce")).toBeTruthy();
    expect(screen.queryByTestId("tool-card-google")).toBeNull();
    expect(screen.queryByTestId("tool-card-notion")).toBeNull();
    // Integrations that are not built yet are not connectors to switch off.
    expect(screen.getByTestId("tool-card-microsoft-365")).toBeTruthy();
  });

  it("points the first-connection prompt at a connector that is offered", async () => {
    writeRuntimeConfig(["salesforce"]);
    stubStatus(["salesforce"]);

    render(createElement(IntegrationsSettings));

    const prompt = await screen.findByRole("link", {
      name: "Connect Salesforce",
    });
    expect(prompt.getAttribute("href")).toBe("/api/oauth/salesforce/start");
    expect(screen.queryByTestId("tool-card-github")).toBeNull();
  });

  it("shows every connector when all are offered", async () => {
    writeRuntimeConfig(["github", "notion", "google", "salesforce"]);
    stubStatus(["github", "notion", "google", "salesforce"]);

    render(createElement(IntegrationsSettings));

    for (const id of ["github", "notion", "google", "salesforce"]) {
      expect(await screen.findByTestId(`tool-card-${id}`)).toBeTruthy();
    }
  });
});
