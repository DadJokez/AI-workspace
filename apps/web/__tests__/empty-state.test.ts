import { describe, expect, it } from "vitest";
import {
  connectedProvidersSummary,
  firstNameFromDisplayName,
  greetingForHour,
  selectEmptyStateSuggestions,
} from "@/lib/empty-state";

describe("personalized chat empty state", () => {
  it("selects distinct prompts for different work roles", () => {
    const engineering = selectEmptyStateSuggestions({
      roleContext: "My role: Engineering.",
      availableProviders: ["github"],
    });
    const sales = selectEmptyStateSuggestions({
      roleContext: "My role: Sales / Account.",
      availableProviders: ["salesforce"],
    });

    expect(engineering).toHaveLength(4);
    expect(sales).toHaveLength(4);
    expect(engineering).not.toEqual(sales);
    expect(engineering[0]).toContain("GitHub");
    expect(sales[0]).toContain("Salesforce");
  });

  it("does not suggest a role-specific tool when it is unavailable", () => {
    const suggestions = selectEmptyStateSuggestions({
      roleContext: "My role: Sales / Account.",
      availableProviders: [],
    });

    expect(suggestions).toHaveLength(4);
    expect(suggestions.join(" ")).not.toContain("Salesforce");
  });

  it("formats the greeting and connected provider copy", () => {
    expect(greetingForHour(8)).toBe("Good morning");
    expect(greetingForHour(14)).toBe("Good afternoon");
    expect(greetingForHour(21)).toBe("Good evening");
    expect(firstNameFromDisplayName("  Rob Lindmark ")).toBe("Rob");
    expect(connectedProvidersSummary([])).toBe(
      "No work tools are connected yet.",
    );
    expect(connectedProvidersSummary(["github", "notion"])).toBe(
      "GitHub and Notion are connected.",
    );
  });
});
