import { describe, expect, it } from "vitest";
import {
  AUTONOMY_PRESETS,
  buildAutonomyReceipt,
  countUnattendedWriteDenials,
  resolveAutonomyPreset,
} from "@/lib/autonomy-presets";

describe("autonomy presets", () => {
  it("binds scheduled and event runs to unattended without a user override", () => {
    expect(resolveAutonomyPreset("scheduled").name).toBe("unattended");
    expect(resolveAutonomyPreset("github_event").name).toBe("unattended");
    expect(resolveAutonomyPreset("chat").name).toBe("interactive");
    expect(resolveAutonomyPreset("skill_retry").name).toBe("interactive");
  });

  it("defines the three presets in one immutable policy vocabulary", () => {
    expect(AUTONOMY_PRESETS.interactive.write).toBe("request_approval");
    expect(AUTONOMY_PRESETS.unattended.write).toBe("deny_and_report");
    expect(AUTONOMY_PRESETS.restricted).toMatchObject({
      read: "allow",
      write: "deny",
      admin: "block",
    });
  });

  it("counts structured and serialized unattended write denials", () => {
    const skipped = countUnattendedWriteDenials([
      { output: { error: "tool_approval_unattended_denied" } },
      { output: JSON.stringify({ error: "tool_approval_unattended_denied" }) },
      { output: { error: "tool_policy_blocked" } },
      { output: "not-json" },
    ]);

    expect(skipped).toBe(2);
    expect(buildAutonomyReceipt("unattended", skipped)).toEqual({
      preset: "unattended",
      skippedWriteCount: 2,
      reason: "denied_unattended",
    });
  });
});
