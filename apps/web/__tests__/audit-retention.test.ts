import { describe, expect, it } from "vitest";
import {
  assertDestructiveAuditRetentionConfigured,
  auditRetentionCutoff,
  DEFAULT_AUDIT_LOG_RETENTION_DAYS,
  MAX_AUDIT_LOG_RETENTION_DAYS,
  MIN_AUDIT_LOG_RETENTION_DAYS,
  resolveAuditRetentionDays,
} from "@/lib/audit-retention";

describe("audit retention", () => {
  it("uses the default retention window for missing or invalid input", () => {
    expect(resolveAuditRetentionDays("")).toBe(DEFAULT_AUDIT_LOG_RETENTION_DAYS);
    expect(resolveAuditRetentionDays("not-a-number")).toBe(
      DEFAULT_AUDIT_LOG_RETENTION_DAYS,
    );
    expect(resolveAuditRetentionDays("-5")).toBe(DEFAULT_AUDIT_LOG_RETENTION_DAYS);
  });

  it("clamps retention days to a safe range", () => {
    expect(resolveAuditRetentionDays("7")).toBe(MIN_AUDIT_LOG_RETENTION_DAYS);
    expect(resolveAuditRetentionDays("99999")).toBe(
      MAX_AUDIT_LOG_RETENTION_DAYS,
    );
  });

  it("computes a deterministic cutoff", () => {
    expect(
      auditRetentionCutoff(new Date("2026-06-19T12:00:00.000Z"), 30).toISOString(),
    ).toBe("2026-05-20T12:00:00.000Z");
  });

  it("requires an explicit retention window before destructive cleanup", () => {
    expect(() =>
      assertDestructiveAuditRetentionConfigured({ dryRun: true }),
    ).not.toThrow();
    expect(() =>
      assertDestructiveAuditRetentionConfigured({ dryRun: false, raw: "365" }),
    ).not.toThrow();
    expect(() =>
      assertDestructiveAuditRetentionConfigured({ dryRun: false }),
    ).toThrow(/AUDIT_LOG_RETENTION_DAYS/);
    expect(() =>
      assertDestructiveAuditRetentionConfigured({
        dryRun: false,
        raw: "not-a-number",
      }),
    ).toThrow(/AUDIT_LOG_RETENTION_DAYS/);
  });
});
