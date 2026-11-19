import type { AuthDenialReason } from "@/lib/auth/auth-audit";

/**
 * What the login page says for a refusal the person can act on. The `signIn`
 * callback puts one of these reason codes on the redirect; the page looks the
 * code up here and shows nothing for a code it does not know, so no text from
 * the URL or from an identity provider is ever rendered.
 *
 * Reasons without an entry (an uninvited address, every magic-link refusal)
 * keep the generic "not authorized" message.
 */
export const SIGN_IN_DENIAL_MESSAGES: Partial<Record<AuthDenialReason, string>> =
  {
    email_in_use:
      "This email address already has an account that signs in a different way. Use the sign-in method you used before.",
    missing_email:
      "Your identity provider did not share an email address for your account. Ask your administrator to release it to this app.",
    invalid_subject:
      "Your identity provider did not identify your account. Contact an admin.",
    groups_claim_unreadable:
      "Your identity provider did not share your group memberships, so access can't be confirmed. Contact an admin.",
    required_group_missing:
      "Your account isn't in the group that has access to this workspace. Ask your administrator for access.",
    provisioning_failed:
      "Sign-in couldn't be completed. Try again in a moment.",
    user_inactive:
      "This account has been suspended or deprovisioned. Contact an admin.",
  };

/** The message for a `reason` query value, or null for anything unknown. */
export function signInDenialMessage(reason: string | undefined): string | null {
  if (!reason || !Object.hasOwn(SIGN_IN_DENIAL_MESSAGES, reason)) return null;
  return SIGN_IN_DENIAL_MESSAGES[reason as AuthDenialReason] ?? null;
}
