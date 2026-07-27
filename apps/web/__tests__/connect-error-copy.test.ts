import { describe, expect, it } from "vitest";
import { connectErrorNotice } from "@/lib/connect-error-copy";

describe("connectErrorNotice", () => {
  it("explains the invite-only access list when Google denies consent", () => {
    const copy = connectErrorNotice("google", "access_denied");
    expect(copy).toBe(
      "Google access for Comparative is invite-only right now, and your " +
        "email may not be on the access list yet. Ask Rob to add you, then " +
        "try connecting again.",
    );
  });

  it("leaves other Google errors on the existing generic copy", () => {
    expect(connectErrorNotice("google", "invalid_state")).toBeUndefined();
    expect(connectErrorNotice("google", "token_exchange_failed")).toBeUndefined();
    expect(connectErrorNotice("google", "config_error")).toBeUndefined();
  });

  it("leaves access_denied from other providers on the existing copy", () => {
    expect(connectErrorNotice("github", "access_denied")).toBeUndefined();
    expect(connectErrorNotice("notion", "access_denied")).toBeUndefined();
  });
});
