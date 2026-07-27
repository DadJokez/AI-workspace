/**
 * Copy for OAuth connect-flow errors that deserve a plain-language
 * explanation on the Integrations settings page, beyond the generic
 * "Auth failed" badge on the integration card.
 *
 * The Google OAuth app deliberately runs in External + Testing mode, so
 * Google refuses the consent screen for any email not hand-added to the
 * app's test-user list and bounces back with error=access_denied. That is
 * usually an access-list gap, not a user mistake — say so honestly.
 *
 * Returns undefined for every other provider/error combination so those
 * keep their existing "Auth failed" treatment.
 */
export function connectErrorNotice(
  provider: string,
  error: string,
): string | undefined {
  if (provider === "google" && error === "access_denied") {
    return (
      "Google access for Comparative is invite-only right now, and your " +
      "email may not be on the access list yet. Ask Rob to add you, then " +
      "try connecting again."
    );
  }
  return undefined;
}
