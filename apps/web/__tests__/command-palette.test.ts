import { describe, expect, it } from "vitest";
import {
  fuzzyScore,
  groupCommandPaletteItems,
  type CommandPaletteItem,
} from "@/lib/command-palette";

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
});
