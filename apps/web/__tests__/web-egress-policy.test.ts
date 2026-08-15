import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEB_EGRESS_POLICY,
  parseDeniedDomainInput,
  saveWebEgressPolicy,
} from "@/lib/web-egress-policy";

describe("web egress policy", () => {
  it("normalizes, deduplicates, and accepts IP literals", () => {
    expect(
      parseDeniedDomainInput([
        " Example.COM. ",
        "example.com",
        "203.0.113.7",
      ]),
    ).toEqual({
      ok: true,
      domains: ["example.com", "203.0.113.7"],
    });
  });

  it("rejects URLs, paths, ports, wildcards, and non-array input", () => {
    expect(
      parseDeniedDomainInput([
        "https://example.com",
        "example.com/path",
        "example.com:443",
        "*.example.com",
      ]),
    ).toMatchObject({ ok: false });
    expect(parseDeniedDomainInput("example.com")).toEqual({
      ok: false,
      invalid: ["denylist"],
    });
  });

  it("defaults to an empty denylist", () => {
    expect(DEFAULT_WEB_EGRESS_POLICY).toEqual({
      name: "admin_domain_denylist",
      deniedDomains: [],
    });
  });

  it("persists its admin catalog row with the blocked default policy", async () => {
    let inserted: Record<string, unknown> | undefined;
    const query: Record<string, unknown> = {};
    query.values = (values: Record<string, unknown>) => {
      inserted = values;
      return query;
    };
    query.onConflictDoUpdate = async () => undefined;
    const db = { insert: () => query } as never;

    await saveWebEgressPolicy(db, []);

    expect(inserted).toMatchObject({
      action: "admin",
      policy: "blocked",
    });
  });
});
