import { describe, expect, it } from "vitest";
import {
  buildDeveloperBriefingPrompt,
  DEVELOPER_BRIEFING_SKILL_SLUG,
} from "@/lib/developer-briefing";

describe("developer briefing prompt", () => {
  it("uses a stable skill slug", () => {
    expect(DEVELOPER_BRIEFING_SKILL_SLUG).toBe("developer-briefing");
  });

  it("includes dated aggregation and CI instructions", () => {
    const prompt = buildDeveloperBriefingPrompt(
      new Date("2026-05-18T12:00:00.000Z"),
    );

    expect(prompt).toContain("Today is 2026-05-18");
    expect(prompt).toContain("updated:<2026-05-11");
    expect(prompt).toContain("review-requested:@me");
    expect(prompt).toContain("classify CI as failing, pending, passing, or unknown");
    expect(prompt).toContain("## Failing or unknown CI");
    expect(prompt).toContain("Never invent PRs, statuses, reviewers, or checks.");
  });
});
