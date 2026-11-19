import { describe, expect, it } from "vitest";
import { decideInitialRole } from "@/lib/users";

describe("decideInitialRole — first-signup-becomes-admin", () => {
  it("promotes the first user (count=0) to admin", () => {
    expect(decideInitialRole(0)).toBe("admin");
  });

  it("assigns user role to subsequent signups", () => {
    expect(decideInitialRole(1)).toBe("user");
    expect(decideInitialRole(2)).toBe("user");
    expect(decideInitialRole(99)).toBe("user");
  });

  it("promotes nobody for arriving first once OIDC is enabled", () => {
    expect(decideInitialRole(0, true)).toBe("user");
    expect(decideInitialRole(1, true)).toBe("user");
    expect(decideInitialRole(0, false)).toBe("admin");
  });
});
