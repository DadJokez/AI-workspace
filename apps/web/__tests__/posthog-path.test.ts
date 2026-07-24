import { describe, expect, it } from "vitest";
import { analyticsPathFor } from "@/lib/posthog-path";

describe("analyticsPathFor", () => {
  it("redacts restricted and user-controlled route segments", () => {
    expect(analyticsPathFor("/invite/super-secret-token")).toBe(
      "/invite/[token]",
    );
    expect(analyticsPathFor("/admin/runs/run-123")).toBe(
      "/admin/runs/[id]",
    );
    expect(analyticsPathFor("/apps/manage/app-123")).toBe(
      "/apps/manage/[id]",
    );
    expect(analyticsPathFor("/apps/customer-roadmap")).toBe(
      "/apps/[slug]",
    );
    expect(analyticsPathFor("/skills/skill-123")).toBe("/skills/[id]");
    expect(analyticsPathFor("/workspace/artifacts/artifact-123")).toBe(
      "/workspace/artifacts/[id]",
    );
  });

  it("keeps static product routes intact", () => {
    expect(analyticsPathFor("/chat")).toBe("/chat");
    expect(analyticsPathFor("/admin/feedback")).toBe("/admin/feedback");
    expect(analyticsPathFor("/skills/new")).toBe("/skills/new");
  });
});
