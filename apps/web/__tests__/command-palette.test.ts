import { describe, expect, it } from "vitest";
import {
  fuzzyScore,
  groupCommandPaletteItems,
  type CommandPaletteItem,
} from "@/lib/command-palette";
import {
  providerReadiness,
  resolveSkillReadiness,
} from "@/lib/command-palette-server";

describe("command palette matching", () => {
  it("prioritizes exact and prefix matches over loose subsequences", () => {
    expect(fuzzyScore("Quarterly launch", "quarterly launch")).toBeGreaterThan(
      fuzzyScore("Quarterly launch notes", "quarterly")!,
    );
    expect(fuzzyScore("Quarterly launch", "qtrl lnch")).not.toBeNull();
    expect(fuzzyScore("Quarterly launch", "salesforce")).toBeNull();
  });

  it("matches descriptions and keywords while preserving group order", () => {
    const items: CommandPaletteItem[] = [
      {
        id: "action:artifacts",
        group: "actions",
        label: "Open artifacts",
        keywords: ["files", "documents"],
      },
      {
        id: "skill:brief",
        group: "skills",
        label: "Weekly brief",
        description: "Summarize project updates",
      },
      {
        id: "thread:launch",
        group: "chats",
        label: "Launch plan",
        description: "Discussed the quarterly release",
      },
    ];

    expect(groupCommandPaletteItems(items, "project")).toEqual([
      {
        id: "skills",
        label: "Skills",
        items: [items[1]],
      },
    ]);
    expect(groupCommandPaletteItems(items, "").map((group) => group.id)).toEqual(
      ["chats", "skills", "actions"],
    );
  });

  it("surfaces an exact resource match above a loose match in an earlier group", () => {
    const items: CommandPaletteItem[] = [
      {
        id: "thread:launch",
        group: "chats",
        label: "Notes from the quarterly launch planning session",
        priority: 40,
      },
      {
        id: "artifact:launch",
        group: "files",
        label: "Quarterly launch",
      },
    ];

    const groups = groupCommandPaletteItems(items, "Quarterly launch");

    expect(groups.map((group) => group.id)).toEqual(["files", "chats"]);
    expect(groups[0]?.items[0]).toBe(items[1]);
  });

  it("uses current-context priority only within the same match tier", () => {
    const items: CommandPaletteItem[] = [
      {
        id: "thread:old",
        group: "chats",
        label: "Launch notes from April",
      },
      {
        id: "thread:current",
        group: "chats",
        label: "Launch notes from May",
        priority: 40,
      },
    ];

    expect(groupCommandPaletteItems(items, "Launch notes")[0]?.items).toEqual([
      items[1],
      items[0],
    ]);
  });
});

describe("command palette readiness", () => {
  it("gives a concrete next step for disconnected and reconnecting tools", () => {
    expect(
      providerReadiness("google", {
        connectedProviders: [],
        allowedProviders: [],
        deniedProviders: [],
        executionUnavailableProviders: [],
        providerAvailability: {},
      }),
    ).toMatchObject({
      state: "connection_required",
      label: "Connect",
    });

    expect(
      providerReadiness("google", {
        connectedProviders: ["google"],
        allowedProviders: [],
        deniedProviders: [],
        executionUnavailableProviders: [],
        providerAvailability: {
          google: {
            connected: true,
            tokenValid: false,
            userApproved: true,
            executionConfigured: true,
            toolMountable: false,
            modelAvailable: false,
            status: "reconnect_required",
          },
        },
      }),
    ).toMatchObject({ state: "reconnect_required", label: "Reconnect" });
  });

  it("blocks a Skill on the strongest provider readiness requirement", () => {
    expect(
      resolveSkillReadiness(["github", "google"], {
        connectedProviders: ["github", "google"],
        allowedProviders: ["github"],
        deniedProviders: [],
        executionUnavailableProviders: [],
        providerAvailability: {
          github: {
            connected: true,
            tokenValid: true,
            userApproved: true,
            executionConfigured: true,
            toolMountable: true,
            modelAvailable: true,
            status: "ready",
          },
          google: {
            connected: true,
            tokenValid: false,
            userApproved: true,
            executionConfigured: true,
            toolMountable: false,
            modelAvailable: false,
            status: "reconnect_required",
          },
        },
      }),
    ).toMatchObject({ state: "reconnect_required", label: "Reconnect" });
  });
});
