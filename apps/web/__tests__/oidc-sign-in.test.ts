import { describe, expect, it } from "vitest";
import {
  OIDC_MAX_GROUPS,
  oidcAccessDenial,
  oidcRole,
  readOidcClaims,
} from "@/lib/auth/oidc-sign-in";

/**
 * The pure half of OIDC sign-in (apps/web/lib/auth/oidc-sign-in.ts): claims
 * are untrusted input, the group gate fails closed, and admin is never
 * granted on a claim that is missing or malformed. The database half runs
 * against real Postgres in __integration__/oidc-sign-in.integration.test.ts.
 */

const oidc = { groupsClaim: "groups" };

function read(claims: unknown, groupsClaim = "groups") {
  const result = readOidcClaims(claims, { groupsClaim });
  if (!result.ok) throw new Error(`claims refused: ${result.reason}`);
  return result.identity;
}

const base = { sub: "abc-123", email: "person@example.com" };

describe("readOidcClaims", () => {
  it("namespaces the subject and lower-cases the address", () => {
    expect(
      read({ sub: "abc-123", email: " Person@Example.COM ", name: "A Person" }),
    ).toEqual({
      subject: "pingone:abc-123",
      email: "person@example.com",
      emailVerified: false,
      displayName: "A Person",
      groups: null,
    });
  });

  it.each([
    ["no claims at all", null],
    ["a string instead of a claim set", "sub=abc"],
    ["no sub", { email: "person@example.com" }],
    ["an empty sub", { ...base, sub: "" }],
    ["a numeric sub", { ...base, sub: 42 }],
    ["a sub over 255 characters", { ...base, sub: "s".repeat(256) }],
    ["a sub with a control character", { ...base, sub: "abc\ndef" }],
  ])("refuses %s as an invalid subject", (_label, claims) => {
    expect(readOidcClaims(claims, oidc)).toEqual({
      ok: false,
      reason: "invalid_subject",
    });
  });

  it.each([
    ["no email", { sub: "abc" }],
    ["an email that is not a string", { sub: "abc", email: ["a@example.com"] }],
    ["an email with no domain", { sub: "abc", email: "person" }],
    ["an email with a space", { sub: "abc", email: "a b@example.com" }],
    ["an oversized email", { sub: "abc", email: `${"a".repeat(320)}@example.com` }],
  ])("refuses %s as a missing email", (_label, claims) => {
    expect(readOidcClaims(claims, oidc)).toEqual({
      ok: false,
      reason: "missing_email",
    });
  });

  it("counts an address as verified only for a literal true", () => {
    expect(read({ ...base, email_verified: true }).emailVerified).toBe(true);
    for (const value of [false, "true", 1, "1", null, undefined, {}]) {
      expect(read({ ...base, email_verified: value }).emailVerified).toBe(false);
    }
  });

  it("bounds the display name and strips control characters from it", () => {
    expect(read({ ...base, name: "Line\none\u0000" }).displayName).toBe(
      "Line one",
    );
    expect(read({ ...base, name: "n".repeat(500) }).displayName).toHaveLength(
      200,
    );
    // Not a string, or blank: fall back to the address.
    expect(read({ ...base, name: { first: "A" } }).displayName).toBe(base.email);
    expect(read({ ...base, name: "   " }).displayName).toBe(base.email);
  });

  it("reads a list of group names, without duplicates", () => {
    expect(read({ ...base, groups: ["a", "b", "a"] }).groups).toEqual(["a", "b"]);
    expect(read({ ...base, groups: [] }).groups).toEqual([]);
  });

  it("reads a bare string as a list of one group, never as a list to split", () => {
    expect(read({ ...base, groups: "admins" }).groups).toEqual(["admins"]);
    expect(read({ ...base, groups: "users,admins" }).groups).toEqual([
      "users,admins",
    ]);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["an object", { admins: true }],
    ["a number", 1],
    ["an empty string", ""],
    ["a list with a number in it", ["users", 1]],
    ["a list with a nested list", ["users", ["admins"]]],
    ["a list with an empty name", ["users", ""]],
    ["a list with an oversized name", ["users", "g".repeat(257)]],
    ["a list with a control character in a name", ["users", "adm\u0000ins"]],
    ["more entries than the cap", Array.from({ length: OIDC_MAX_GROUPS + 1 }, (_, i) => `g${i}`)],
  ])("reads a groups claim that is %s as unreadable, not as a partial list", (_label, groups) => {
    expect(read({ ...base, groups }).groups).toBeNull();
  });

  it("reads groups from the configured claim only", () => {
    const claims = { ...base, groups: ["wrong"], "https://example.com/groups": ["right"] };
    expect(read(claims, "https://example.com/groups").groups).toEqual(["right"]);
    expect(read(base, "roles").groups).toBeNull();
  });

  it("does not read claims from the prototype chain", () => {
    const inherited = Object.create({ sub: "inherited", groups: ["admins"] });
    expect(readOidcClaims(inherited, oidc)).toEqual({
      ok: false,
      reason: "invalid_subject",
    });
    // A claim name that collides with an Object.prototype member is absent.
    expect(read(base, "constructor").groups).toBeNull();
    expect(read(base, "__proto__").groups).toBeNull();
  });
});

describe("oidcAccessDenial (OIDC_REQUIRED_GROUP)", () => {
  const required = { requiredGroup: "comparative-users" };

  it("admits a member of the required group", () => {
    expect(
      oidcAccessDenial({ groups: ["x", "comparative-users"] }, required),
    ).toBeNull();
  });

  it("fails closed on a missing or malformed claim", () => {
    expect(oidcAccessDenial({ groups: null }, required)).toBe(
      "groups_claim_unreadable",
    );
  });

  it("matches the whole name, case-sensitively", () => {
    for (const groups of [
      [],
      ["comparative-users-external"],
      ["Comparative-Users"],
      ["comparative-users "],
      ["other,comparative-users"],
    ]) {
      expect(oidcAccessDenial({ groups }, required)).toBe(
        "required_group_missing",
      );
    }
  });

  it("admits anyone the identity provider authenticated when no group is required", () => {
    expect(oidcAccessDenial({ groups: null }, { requiredGroup: null })).toBeNull();
    expect(oidcAccessDenial({ groups: [] }, { requiredGroup: null })).toBeNull();
  });
});

describe("oidcRole (OIDC_ADMIN_GROUP)", () => {
  const admin = { adminGroup: "comparative-admins" };

  it("is admin only for a member of the admin group", () => {
    expect(oidcRole({ groups: ["comparative-admins"] }, admin)).toBe("admin");
    expect(oidcRole({ groups: ["comparative-users"] }, admin)).toBe("user");
    expect(oidcRole({ groups: ["Comparative-Admins"] }, admin)).toBe("user");
    expect(oidcRole({ groups: [] }, admin)).toBe("user");
  });

  it("never grants admin on a missing or malformed claim", () => {
    expect(oidcRole({ groups: null }, admin)).toBe("user");
  });

  it("leaves the stored role alone when no admin group is configured", () => {
    expect(oidcRole({ groups: ["comparative-admins"] }, { adminGroup: null })).toBeNull();
    expect(oidcRole({ groups: null }, { adminGroup: null })).toBeNull();
  });
});
